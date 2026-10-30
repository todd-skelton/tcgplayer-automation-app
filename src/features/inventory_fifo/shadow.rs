//! The FIFO replay in shadow: every seller SKU Node has replayed and not queued again is
//! replayed here and each line's fingerprint compared with the revision Node saved. It writes
//! nothing; a difference means one of the two would save another revision.
use std::{
    collections::BTreeMap, collections::HashMap, io::Write, path::Path, path::PathBuf,
    time::Duration,
};

use corten::Signal;
use serde::Serialize;
use tokio::time::{MissedTickBehavior, interval};

use super::replay::{self, Replay};
use crate::{database::Database, features::shipping_configuration};

/// How often every settled SKU is compared. Node replays a SKU when an order or stock changes;
/// an hour leaves its queue time to settle between passes.
pub const EVERY: Duration = Duration::from_secs(60 * 60);

fn log_path() -> Option<PathBuf> {
    std::env::var("FIFO_SHADOW_LOG")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
}

/// One SKU's comparison.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum Verdict {
    /// Every line's fingerprint is the one Node saved, and the SKU is held for the same reason.
    Same { lines: usize },
    /// Lines whose fingerprint differs from Node's, or that Node has not saved.
    Differs {
        lines: Vec<LineDiff>,
        held: Option<String>,
        node_held: Option<String>,
    },
    /// The SKU is held before any line is saved; Node's queue says why it holds it, if it does.
    Held {
        reason: String,
        node_held: Option<String>,
    },
    /// The allocator refused the SKU's inputs.
    Refused { reason: String },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LineDiff {
    pub order_id: String,
    pub sku_id: String,
    pub state: &'static str,
    pub fingerprint: String,
    pub node_fingerprint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Compared {
    pub sku: i32,
    #[serde(flatten)]
    pub verdict: Verdict,
}

/// Compares one SKU, reading in a read-only transaction.
pub async fn compare(db: &Database, seller: &str, sku: i32) -> sqlx::Result<Compared> {
    let mut tx = db.0.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    let loaded = replay::load(&mut tx, seller, sku).await?;
    let node_held: Option<String> = sqlx::query_scalar(
        "SELECT hold_reason FROM inventory_fifo_replay_queue WHERE seller_key=$1 AND sku=$2 AND status='held'",
    )
    .bind(seller)
    .bind(sku)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let saved: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT line.order_id::text, line.order_line_sku_id, revision.source_fingerprint
         FROM inventory_fifo_lines line LEFT JOIN inventory_fifo_revisions revision ON revision.id=line.current_revision_id
         WHERE line.seller_key=$1 AND line.sku=$2",
    )
    .bind(seller)
    .bind(sku)
    .fetch_all(&mut *tx)
    .await?;
    tx.rollback().await?;
    let saved: HashMap<(String, String), Option<String>> = saved
        .into_iter()
        .map(|(order, line, fingerprint)| ((order, line), fingerprint))
        .collect();
    let verdict = match loaded.map(|inputs| replay::plan(&inputs)) {
        Err(reason) => Verdict::Held { reason, node_held },
        Ok(Err(refused)) => Verdict::Refused {
            reason: refused.to_string(),
        },
        Ok(Ok(Replay::Held(reason))) => Verdict::Held { reason, node_held },
        Ok(Ok(Replay::Saved { lines, held })) => {
            let count = lines.len();
            let diffs: Vec<LineDiff> = lines
                .iter()
                .filter_map(|line| {
                    let fingerprint = replay::fingerprint(line);
                    let node = saved
                        .get(&(line.order_id.clone(), line.sku_id.clone()))
                        .cloned()
                        .flatten();
                    (node.as_deref() != Some(fingerprint.as_str())).then(|| LineDiff {
                        order_id: line.order_id.clone(),
                        sku_id: line.sku_id.clone(),
                        state: line.state,
                        fingerprint,
                        node_fingerprint: node,
                    })
                })
                .collect();
            if diffs.is_empty() && held == node_held {
                Verdict::Same { lines: count }
            } else {
                Verdict::Differs {
                    lines: diffs,
                    held,
                    node_held,
                }
            }
        }
    };
    Ok(Compared { sku, verdict })
}

/// The SKUs Node has replayed and not queued again since.
pub async fn settled_skus(db: &Database, seller: &str) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        "SELECT DISTINCT line.sku FROM inventory_fifo_lines line
         WHERE line.seller_key=$1 AND line.sku IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM inventory_fifo_replay_queue queue
             WHERE queue.seller_key=line.seller_key AND queue.sku=line.sku AND queue.status<>'held')
         ORDER BY line.sku",
    )
    .bind(seller)
    .fetch_all(&db.0)
    .await
}

/// A pass's tally, by verdict.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Tally {
    pub at: String,
    pub skus: BTreeMap<&'static str, usize>,
}

impl Tally {
    /// No SKU would be saved differently: the pass counts toward switching the replay over.
    pub fn clean(&self) -> bool {
        self.skus
            .keys()
            .all(|kind| matches!(*kind, "same" | "held_alike"))
    }
}

/// Compares every settled SKU and appends a line for each one that is not the same, then the tally.
pub async fn pass(db: &Database, seller: &str, log: &Path) -> Result<Tally, String> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| e.to_string())?;
    let mut tally = Tally {
        at: chrono::Utc::now().to_rfc3339(),
        ..Tally::default()
    };
    for sku in settled_skus(db, seller).await.map_err(|e| e.to_string())? {
        let compared = compare(db, seller, sku).await.map_err(|e| e.to_string())?;
        let kind = match &compared.verdict {
            Verdict::Same { .. } => "same",
            Verdict::Differs { .. } => "differs",
            Verdict::Held { reason, node_held } if Some(reason) == node_held.as_ref() => {
                "held_alike"
            }
            Verdict::Held { .. } => "held_differently",
            Verdict::Refused { .. } => "refused",
        };
        *tally.skus.entry(kind).or_default() += 1;
        if !matches!(kind, "same" | "held_alike") {
            writeln!(
                file,
                "{}",
                serde_json::to_string(&compared).map_err(|e| e.to_string())?
            )
            .map_err(|e| e.to_string())?;
        }
    }
    writeln!(
        file,
        "{}",
        serde_json::to_string(&tally).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;
    Ok(tally)
}

/// The task: when `FIFO_SHADOW_LOG` names a log, a pass at once, then every [`EVERY`], until shutdown.
pub async fn run(db: Database, signal: Signal) {
    let Some(log) = log_path() else {
        return;
    };
    println!("FIFO shadow: logging to {}", log.display());
    let mut every = interval(EVERY);
    every.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = every.tick() => {}
        }
        let seller = match shipping_configuration::default_seller_key(&db).await {
            Ok(seller) if !seller.trim().is_empty() => seller,
            Ok(_) => continue,
            Err(why) => {
                eprintln!("FIFO shadow: seller configuration failed: {why}");
                continue;
            }
        };
        match pass(&db, seller.trim(), &log).await {
            Ok(tally) => println!(
                "FIFO shadow: {} {:?}",
                if tally.clean() { "clean" } else { "differs" },
                tally.skus
            ),
            Err(why) => eprintln!("FIFO shadow pass failed: {why}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "reads the dev database"]
    async fn matches_node_saved_lines() {
        crate::config::load_env();
        let log = log_path().expect("FIFO_SHADOW_LOG names the log");
        let db = Database::connect_lazy(&crate::config::database_url());
        let seller = shipping_configuration::default_seller_key(&db)
            .await
            .unwrap();
        let tally = pass(&db, seller.trim(), &log).await.unwrap();
        println!("{:?}", tally.skus);
    }
}
