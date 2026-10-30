//! The seller order history worker in shadow (port decision 24): it reads TCGplayer as the Node
//! worker does and, instead of recording, compares what it read with the rows Node recorded and
//! writes one JSON line per order to a log. It writes nothing to the database.
//!
//! It runs when `SELLER_ORDER_SHADOW_LOG` names the log file. Each pass reads one page of the last
//! three months' orders, oldest first, continuing where the last pass ended and starting over at
//! the end, and reads the detail of at most [`DETAILS`] orders: those Node would read again, and
//! then a few Node already holds, to check this side fingerprints them as Node did.
use std::{collections::HashMap, io::Write, path::PathBuf, time::Duration};

use corten::Signal;
use serde::Serialize;
use tokio::time::{MissedTickBehavior, interval};

use super::{
    api,
    observation::{self, Fields},
};
use crate::{database::Database, features::shipping_configuration, tcgplayer::TcgPlayer};

/// How often a pass runs: Node looks hourly once it has read everything, sooner while catching
/// up; the shadow reads at most a page a pass, so it goes every ten minutes.
pub const EVERY: Duration = Duration::from_secs(10 * 60);
/// Search results per page; Node reads 500, the shadow a smaller share of TCGplayer's patience.
pub const PAGE: u32 = 100;
/// Details read per pass; Node reads 25.
pub const DETAILS: usize = 25;
/// Of those, at most this many are orders Node already holds, read to check fingerprints.
pub const CHECKS: usize = 5;

/// The log the shadow writes, when it runs.
fn log_path() -> Option<PathBuf> {
    std::env::var("SELLER_ORDER_SHADOW_LOG")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
}

/// What Node holds of an order.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub summary_fingerprint: Option<String>,
    pub source_fingerprint: String,
    pub source_revision: i32,
}

/// What the shadow concludes about one order.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum Verdict {
    /// Node holds the search result as it is now, and its detail was not read.
    Unchanged,
    /// Node would read the detail, but this pass's budget was spent.
    Deferred,
    /// Node holds the order, and the detail fingerprints as Node recorded it.
    Agrees { revision: i32 },
    /// Node holds the search result as it is now, but the detail fingerprints differently: a
    /// parity bug, or TCGplayer changed the order without its search result showing it.
    Differs {
        ours: String,
        theirs: String,
        revision: i32,
    },
    /// Node has not recorded the order: it would record revision 1.
    WouldRecord,
    /// The search result changed and so did the detail: Node would record the next revision.
    WouldRevise { revision: i32 },
    /// The search result changed but the detail did not: Node would only note the new result.
    WouldNoteSummary { revision: i32 },
    /// The detail could not be read or observed.
    Failed { why: String },
}

/// The verdict on an order Node would read again, from its detail's fingerprint.
pub fn after_reading(stored: Option<&Stored>, ours: &str) -> Verdict {
    match stored {
        None => Verdict::WouldRecord,
        Some(s) if s.source_fingerprint == ours => Verdict::WouldNoteSummary {
            revision: s.source_revision,
        },
        Some(s) => Verdict::WouldRevise {
            revision: s.source_revision + 1,
        },
    }
}

/// The verdict on an order Node holds as it is, from its detail's fingerprint.
pub fn after_checking(stored: &Stored, ours: &str) -> Verdict {
    if stored.source_fingerprint == ours {
        Verdict::Agrees {
            revision: stored.source_revision,
        }
    } else {
        Verdict::Differs {
            ours: ours.to_owned(),
            theirs: stored.source_fingerprint.clone(),
            revision: stored.source_revision,
        }
    }
}

/// Which of a page's orders to read, in page order: every one Node would read, up to the budget,
/// then up to [`CHECKS`] of the rest. The others are deferred or unchanged.
pub fn plan(needed: &[bool]) -> Vec<Read> {
    let mut details = 0;
    let mut checks = 0;
    let mut reads: Vec<Read> = needed
        .iter()
        .map(|&needed| {
            if needed && details < DETAILS {
                details += 1;
                Read::Again
            } else if needed {
                Read::Deferred
            } else {
                Read::Unchanged
            }
        })
        .collect();
    for read in reads.iter_mut().rev() {
        if *read == Read::Unchanged && checks < CHECKS && details < DETAILS {
            *read = Read::Check;
            checks += 1;
            details += 1;
        }
    }
    reads
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Read {
    /// Node would read the detail again; so does the shadow.
    Again,
    /// Node would read it, past the budget.
    Deferred,
    /// Node would not; the shadow reads it to check the fingerprint.
    Check,
    /// Neither reads it.
    Unchanged,
}

#[derive(Serialize)]
struct Line<'a> {
    at: String,
    offset: u32,
    order_number: &'a str,
    #[serde(flatten)]
    verdict: &'a Verdict,
}

async fn stored(
    db: &Database,
    seller: &str,
    numbers: &[String],
) -> sqlx::Result<HashMap<String, Stored>> {
    let rows: Vec<(String, Option<String>, String, i32)> = sqlx::query_as(
        "SELECT order_number, summary_fingerprint, source_fingerprint, source_revision
         FROM seller_orders WHERE seller_key = $1 AND order_number = ANY($2)",
    )
    .bind(seller)
    .bind(numbers)
    .fetch_all(&db.0)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(number, summary, source, revision)| {
            (
                number,
                Stored {
                    summary_fingerprint: summary,
                    source_fingerprint: source,
                    source_revision: revision,
                },
            )
        })
        .collect())
}

/// One pass from `offset`; where the next one starts.
async fn pass(db: &Database, tcg: &TcgPlayer, log: &PathBuf, offset: u32) -> Result<u32, String> {
    let seller = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| e.to_string())?;
    let seller = seller.trim();
    if seller.is_empty() {
        return Ok(0);
    }
    // Node's overlap: a few orders of the last page again, so one that moved is not missed.
    let from = if offset == 0 {
        0
    } else {
        offset.saturating_sub((PAGE / 10).clamp(1, 25))
    };
    let page = api::search(tcg, seller, from, PAGE)
        .await
        .map_err(|e| e.to_string())?;
    let numbers: Vec<String> = page
        .orders
        .iter()
        .map(|o| {
            o.get("orderNumber")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_owned()
        })
        .collect();
    let held = stored(db, seller, &numbers)
        .await
        .map_err(|e| e.to_string())?;
    let fingerprints: Vec<Result<String, String>> = page
        .orders
        .iter()
        .map(observation::summary_fingerprint)
        .collect();
    let needed: Vec<bool> = numbers
        .iter()
        .zip(&fingerprints)
        .map(|(number, fp)| match fp {
            Ok(fp) => observation::needs_detail(
                Some(
                    held.get(number)
                        .and_then(|s| s.summary_fingerprint.as_deref()),
                ),
                fp,
            ),
            Err(_) => true,
        })
        .collect();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut lines = Vec::with_capacity(numbers.len());
    for (((summary, number), read), fp) in page
        .orders
        .iter()
        .zip(&numbers)
        .zip(plan(&needed))
        .zip(&fingerprints)
    {
        let verdict = match (read, fp) {
            (_, Err(why)) => Verdict::Failed { why: why.clone() },
            (Read::Unchanged, _) => Verdict::Unchanged,
            (Read::Deferred, _) => Verdict::Deferred,
            (Read::Again | Read::Check, _) => {
                match detail(tcg, seller, summary, number, &now).await {
                    Err(why) => Verdict::Failed { why },
                    Ok(ours) => match (read, held.get(number)) {
                        (Read::Check, Some(stored)) => after_checking(stored, &ours),
                        (_, stored) => after_reading(stored, &ours),
                    },
                }
            }
        };
        lines.push((number.as_str(), verdict));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("the shadow log did not open: {e}"))?;
    for (number, verdict) in &lines {
        let line = Line {
            at: now.clone(),
            offset: from,
            order_number: number,
            verdict,
        };
        let text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        writeln!(file, "{text}").map_err(|e| e.to_string())?;
    }
    let next = from + page.orders.len() as u32;
    let end = page.orders.len() < PAGE as usize || next >= page.total_orders;
    Ok(if end { 0 } else { next })
}

/// An order's detail, observed as Node would record it: its fingerprint.
async fn detail(
    tcg: &TcgPlayer,
    seller: &str,
    summary: &Fields,
    number: &str,
    now: &str,
) -> Result<String, String> {
    let detail = api::order(tcg, number).await.map_err(|e| e.to_string())?;
    let read = detail
        .get("orderNumber")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    if read != number.trim() {
        return Err("detail order number did not match search result".into());
    }
    Ok(observation::observe(seller, Some(summary), &detail, now)?.fingerprint)
}

/// The task: when [`log_path`] names a log, a pass at once, then every [`EVERY`], until shutdown.
pub async fn run(db: Database, signal: Signal) {
    let Some(log) = log_path() else {
        return;
    };
    println!("Seller order shadow: logging to {}", log.display());
    let tcg = TcgPlayer::new(db.clone());
    let mut every = interval(EVERY);
    every.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut offset = 0;
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = every.tick() => {}
        }
        match pass(&db, &tcg, &log, offset).await {
            Ok(next) => offset = next,
            Err(why) => eprintln!("Seller order shadow pass failed: {why}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One pass from `SELLER_ORDER_SHADOW_FROM`, or over the newest page, logged to
    /// `SELLER_ORDER_SHADOW_LOG`.
    #[tokio::test]
    #[ignore = "reads TCGplayer live with the dev database's cookie"]
    async fn a_pass_over_the_newest_page() {
        crate::config::load_env();
        let log = log_path().expect("SELLER_ORDER_SHADOW_LOG names the log");
        let db = Database::connect_lazy(&crate::config::database_url());
        let tcg = TcgPlayer::new(db.clone());
        let seller = shipping_configuration::default_seller_key(&db)
            .await
            .unwrap();
        let total = api::search(&tcg, seller.trim(), 0, 2)
            .await
            .unwrap()
            .total_orders;
        let from = std::env::var("SELLER_ORDER_SHADOW_FROM")
            .ok()
            .and_then(|f| f.parse().ok())
            .unwrap_or(total.saturating_sub(PAGE) + (PAGE / 10).clamp(1, 25));
        pass(&db, &tcg, &log, from).await.unwrap();
    }

    fn stored(fp: &str, revision: i32) -> Stored {
        Stored {
            summary_fingerprint: Some("s".into()),
            source_fingerprint: fp.into(),
            source_revision: revision,
        }
    }

    #[test]
    fn a_read_order_is_new_revised_or_only_noted() {
        assert_eq!(after_reading(None, "a"), Verdict::WouldRecord);
        assert_eq!(
            after_reading(Some(&stored("a", 2)), "a"),
            Verdict::WouldNoteSummary { revision: 2 }
        );
        assert_eq!(
            after_reading(Some(&stored("a", 2)), "b"),
            Verdict::WouldRevise { revision: 3 }
        );
    }

    #[test]
    fn a_checked_order_agrees_or_differs() {
        assert_eq!(
            after_checking(&stored("a", 4), "a"),
            Verdict::Agrees { revision: 4 }
        );
        assert_eq!(
            after_checking(&stored("a", 4), "b"),
            Verdict::Differs {
                ours: "b".into(),
                theirs: "a".into(),
                revision: 4
            }
        );
    }

    #[test]
    fn the_plan_reads_what_node_would_then_checks_the_newest_of_the_rest() {
        let reads = plan(&[true, false, false, true, false]);
        assert_eq!(
            reads,
            [
                Read::Again,
                Read::Check,
                Read::Check,
                Read::Again,
                Read::Check
            ]
        );
        let mut needed = vec![true; DETAILS + 2];
        needed.extend([false; 3]);
        let reads = plan(&needed);
        assert_eq!(reads.iter().filter(|r| **r == Read::Again).count(), DETAILS);
        assert_eq!(reads.iter().filter(|r| **r == Read::Deferred).count(), 2);
        assert!(
            !reads.contains(&Read::Check),
            "the budget went to what Node would read"
        );
        let reads = plan(&[false; 8]);
        assert_eq!(reads.iter().filter(|r| **r == Read::Check).count(), CHECKS);
        assert_eq!(&reads[..3], [Read::Unchanged; 3]);
    }

    #[test]
    fn a_verdict_is_logged_as_one_flat_line() {
        let verdict = Verdict::WouldRevise { revision: 3 };
        let line = Line {
            at: "t".into(),
            offset: 0,
            order_number: "A-1",
            verdict: &verdict,
        };
        assert_eq!(
            serde_json::to_string(&line).unwrap(),
            r#"{"at":"t","offset":0,"order_number":"A-1","verdict":"would_revise","revision":3}"#
        );
    }
}
