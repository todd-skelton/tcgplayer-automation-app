//! Completes the forecast evidence of published items for the configured seller, so the selling
//! history's details show what each item was priced with. The Node app did it on every load of
//! the screen; here a page only reads, and this task writes, every few minutes, until no item is
//! left without it. Running beside the Node app's loads is safe: an item gets its evidence once.
use std::time::Duration;

use corten::Signal;
use tokio::time::{MissedTickBehavior, interval};

use super::selling_history::source::{BACKFILL_LIMIT, backfill_supported_forecast_evidence};
use crate::{database::Database, features::continuous_pricing::store};

/// How often the task looks for items without forecast evidence.
pub const EVERY: Duration = Duration::from_secs(5 * 60);

/// The task: a backfill at once, then every [`EVERY`], until shutdown.
pub async fn run(db: Database, signal: Signal) {
    let mut every = interval(EVERY);
    every.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = every.tick() => {}
        }
        match backfill(&db, &signal).await {
            Ok(0) => {}
            Ok(recorded) => println!("Forecast evidence recorded on {recorded} published items."),
            Err(why) => eprintln!("Forecast evidence backfill failed: {why}"),
        }
    }
}

/// Records evidence on every item that lacks it, a batch at a time; how many it recorded.
async fn backfill(db: &Database, signal: &Signal) -> Result<u64, String> {
    let seller = store::settings(db)
        .await
        .map_err(|e| e.to_string())?
        .seller_key;
    if seller.trim().is_empty() {
        return Ok(0);
    }
    let mut recorded = 0;
    loop {
        let batch = backfill_supported_forecast_evidence(db, &seller, BACKFILL_LIMIT).await?;
        recorded += batch;
        if batch < BACKFILL_LIMIT as u64 || signal.is_aborted() {
            return Ok(recorded);
        }
    }
}
