//! The seller order history worker in shadow (port decision 24): the ported sync runs as the Node
//! worker does, but its run is kept in this process and each order it would record is compared
//! with the row Node holds and written to a log as one JSON line. It writes nothing to the
//! database.
//!
//! It runs when `SELLER_ORDER_SHADOW_LOG` names the log file. A step reads one page of the last
//! three months' orders and at most [`BUDGET`]'s details, every [`EVERY`].
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

use corten::Signal;
use serde::Serialize;
use tokio::time::{MissedTickBehavior, interval};

use super::{
    api::{self, SearchPage},
    observation::{Fields, Observation},
    sync::{self, Budget, Coverage, MemoryRun, Orders, Progress, Run, Store},
};
use crate::{
    database::Database,
    features::shipping_configuration,
    tcgplayer::{Failure, TcgPlayer},
};

/// How often a step runs. Node steps every two seconds while a scan is behind and hourly once it
/// is complete; the shadow reads a smaller page, more slowly, beside it.
pub const EVERY: Duration = Duration::from_secs(10 * 60);
/// A step's reads: Node's, but pages of 100 rather than 500.
pub const BUDGET: Budget = Budget {
    max_pages: 1,
    max_details: 25,
    page_size: 100,
    detail_concurrency: 5,
};

fn log_path() -> Option<PathBuf> {
    std::env::var("SELLER_ORDER_SHADOW_LOG")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
}

/// What Node holds of an order.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub source_fingerprint: String,
    pub source_revision: i32,
}

/// What recording an order would do to Node's history.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum Verdict {
    /// Node has not recorded the order: it would record its revision 1.
    New,
    /// The order changed: Node would record its next revision.
    Revised { revision: i32 },
    /// Only its search result changed: Node would note the new result, keeping the revision.
    SummaryOnly { revision: i32 },
}

impl Verdict {
    pub fn of(stored: Option<&Stored>, fingerprint: &str) -> Verdict {
        match stored {
            None => Verdict::New,
            Some(s) if s.source_fingerprint == fingerprint => Verdict::SummaryOnly {
                revision: s.source_revision,
            },
            Some(s) => Verdict::Revised {
                revision: s.source_revision + 1,
            },
        }
    }

    /// Whether the history would change, as `recordObservation` says.
    pub fn changes(&self) -> bool {
        !matches!(self, Verdict::SummaryOnly { .. })
    }
}

/// A line of the log.
#[derive(Serialize)]
#[serde(untagged)]
enum Line<'a> {
    Order {
        at: &'a str,
        order_number: &'a str,
        #[serde(flatten)]
        verdict: &'a Verdict,
    },
    Step {
        at: &'a str,
        status: &'a str,
        next_offset: u32,
        expected_total: Option<u32>,
        orders_observed: u32,
        gaps: usize,
        error: Option<&'a str>,
        changed: usize,
    },
}

/// TCGplayer, read live.
struct Live<'a>(&'a TcgPlayer);

impl Orders for Live<'_> {
    async fn search(&self, seller: &str, from: u32, size: u32) -> Result<SearchPage, Failure> {
        api::search(self.0, seller, from, size).await
    }
    async fn find(&self, seller: &str, number: &str) -> Result<Option<Fields>, Failure> {
        api::find(self.0, seller, number).await
    }
    async fn order(&self, number: &str) -> Result<Fields, Failure> {
        api::order(self.0, number).await
    }
}

/// Node's history read, the run kept here, and the orders it would record logged.
struct Shadow<'a> {
    db: &'a Database,
    run: &'a MemoryRun,
    lines: Mutex<Vec<(String, Verdict)>>,
}

impl Store for Shadow<'_> {
    async fn start_or_resume(&self, _: &str, _: &str) -> Result<Option<Run>, String> {
        Ok(Some(self.run.start()))
    }
    async fn coverage(&self, _: &str) -> Result<Coverage, String> {
        Ok(self.run.coverage())
    }
    async fn record(&self, _: &Run, _: &str, o: &Observation) -> Result<bool, String> {
        let row: Option<(String, i32)> = sqlx::query_as(
            "SELECT source_fingerprint, source_revision FROM seller_orders
             WHERE seller_key = $1 AND order_number = $2",
        )
        .bind(&o.seller_key)
        .bind(&o.order_number)
        .fetch_optional(&self.db.0)
        .await
        .map_err(|e| e.to_string())?;
        let stored = row.map(|(source_fingerprint, source_revision)| Stored {
            source_fingerprint,
            source_revision,
        });
        let verdict = Verdict::of(stored.as_ref(), &o.fingerprint);
        let changes = verdict.changes();
        self.lines
            .lock()
            .expect("lines lock")
            .push((o.order_number.clone(), verdict));
        Ok(changes)
    }
    async fn details_needed(
        &self,
        seller: &str,
        summaries: &[(String, String)],
    ) -> Result<HashSet<String>, String> {
        let numbers: Vec<&str> = summaries.iter().map(|(n, _)| n.as_str()).collect();
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT order_number, summary_fingerprint FROM seller_orders
             WHERE seller_key = $1 AND order_number = ANY($2)",
        )
        .bind(seller)
        .bind(&numbers)
        .fetch_all(&self.db.0)
        .await
        .map_err(|e| e.to_string())?;
        let held: HashMap<String, Option<String>> = rows.into_iter().collect();
        Ok(summaries
            .iter()
            .filter(|(n, fp)| {
                super::observation::needs_detail(held.get(n).map(|s| s.as_deref()), fp)
            })
            .map(|(n, _)| n.clone())
            .collect())
    }
    async fn api_verified(
        &self,
        seller: &str,
        numbers: &[String],
    ) -> Result<HashSet<String>, String> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT order_number FROM seller_orders
             WHERE seller_key = $1 AND latest_source = 'tcgplayer_api' AND order_number = ANY($2)",
        )
        .bind(seller)
        .bind(numbers)
        .fetch_all(&self.db.0)
        .await
        .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().map(|(n,)| n).collect())
    }
    async fn save_progress(&self, p: Progress<'_>) -> Result<Coverage, String> {
        Ok(self.run.save(&p))
    }
    async fn finish(
        &self,
        _: &Run,
        _: &str,
        complete: bool,
        error: Option<&str>,
    ) -> Result<Coverage, String> {
        Ok(self.run.finish(complete, error))
    }
    async fn restart(&self, _: &Run, _: &str, error: &str) -> Result<Coverage, String> {
        Ok(self.run.restart(error))
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One step of the shadow's scan, its lines appended to `log`.
async fn step(
    db: &Database,
    tcg: &TcgPlayer,
    run: &MemoryRun,
    log: &PathBuf,
    budget: Budget,
) -> Result<(), String> {
    let seller = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| e.to_string())?;
    if seller.trim().is_empty() {
        return Ok(());
    }
    let shadow = Shadow {
        db,
        run,
        lines: Mutex::new(Vec::new()),
    };
    let claim = "shadow";
    let synced = sync::synchronize(&Live(tcg), &shadow, &seller, budget, &[], claim, &now).await?;
    let at = now();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("the shadow log did not open: {e}"))?;
    let lines = shadow.lines.into_inner().expect("lines lock");
    let c = &synced.coverage;
    let summary = Line::Step {
        at: &at,
        status: &c.status,
        next_offset: c.next_offset,
        expected_total: c.expected_total,
        orders_observed: c.orders_observed,
        gaps: c.gaps.len(),
        error: c.error.as_deref(),
        changed: synced.changed.len(),
    };
    let orders = lines.iter().map(|(number, verdict)| Line::Order {
        at: &at,
        order_number: number,
        verdict,
    });
    for line in orders.chain(std::iter::once(summary)) {
        let text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
        writeln!(file, "{text}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The task: when `SELLER_ORDER_SHADOW_LOG` names a log, a step at once, then every [`EVERY`],
/// until shutdown.
pub async fn run(db: Database, signal: Signal) {
    let Some(log) = log_path() else {
        return;
    };
    println!("Seller order shadow: logging to {}", log.display());
    let tcg = TcgPlayer::new(db.clone());
    let run = MemoryRun::default();
    let mut every = interval(EVERY);
    every.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = every.tick() => {}
        }
        // A step reads TCGplayer for up to minutes: shutdown must not wait for it.
        let stepped = tokio::select! {
            biased;
            _ = signal.aborted() => return,
            stepped = step(&db, &tcg, &run, &log, BUDGET) => stepped,
        };
        if let Err(why) = stepped {
            eprintln!("Seller order shadow step failed: {why}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Steps from `SELLER_ORDER_SHADOW_FROM` (default: the newest page), logged to
    /// `SELLER_ORDER_SHADOW_LOG`; `SELLER_ORDER_SHADOW_STEPS` of them (default 1).
    #[tokio::test]
    #[ignore = "reads TCGplayer live with the dev database's cookie"]
    async fn steps_from_an_offset() {
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
        let var = |name: &str| std::env::var(name).ok().and_then(|v| v.parse::<u32>().ok());
        let from =
            var("SELLER_ORDER_SHADOW_FROM").unwrap_or(total.saturating_sub(BUDGET.page_size));
        let run = MemoryRun::at(from, Some(total), &[]);
        for _ in 0..var("SELLER_ORDER_SHADOW_STEPS").unwrap_or(1) {
            step(&db, &tcg, &run, &log, BUDGET).await.unwrap();
        }
    }

    fn stored(fp: &str, revision: i32) -> Stored {
        Stored {
            source_fingerprint: fp.into(),
            source_revision: revision,
        }
    }

    #[test]
    fn an_order_is_new_revised_or_only_noted() {
        assert_eq!(Verdict::of(None, "a"), Verdict::New);
        assert_eq!(
            Verdict::of(Some(&stored("a", 2)), "a"),
            Verdict::SummaryOnly { revision: 2 }
        );
        assert_eq!(
            Verdict::of(Some(&stored("a", 2)), "b"),
            Verdict::Revised { revision: 3 }
        );
        assert!(Verdict::New.changes() && !Verdict::SummaryOnly { revision: 1 }.changes());
    }

    #[test]
    fn lines_are_flat_json() {
        let verdict = Verdict::Revised { revision: 3 };
        let order = Line::Order {
            at: "t",
            order_number: "A-1",
            verdict: &verdict,
        };
        assert_eq!(
            serde_json::to_string(&order).unwrap(),
            r#"{"at":"t","order_number":"A-1","verdict":"revised","revision":3}"#
        );
        let step = Line::Step {
            at: "t",
            status: "incomplete",
            next_offset: 100,
            expected_total: Some(1600),
            orders_observed: 100,
            gaps: 0,
            error: Some("Sync request budget reached; resume from the saved offset."),
            changed: 4,
        };
        assert!(
            serde_json::to_string(&step)
                .unwrap()
                .starts_with(r#"{"at":"t","status":"incomplete","next_offset":100"#)
        );
    }
}
