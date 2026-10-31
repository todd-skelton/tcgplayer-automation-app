//! The pricing worker's jobs on Postgres (`processJob`): claim the most urgent queued job, price
//! its batch while its progress rides on each renewal, save the results and complete the job in
//! one transaction fenced on the claim, then bring the strategy's curves, the continuous
//! inventory and automatic publication up to date with it. A job that stopped because TCGplayer
//! no longer shows full sales history fails, and its continuous SKUs are tried again later.
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgConnection;

use super::{
    job::{self, MarketData, Mode, Priced},
    queue::{self, Claimed},
    save,
    worker::{Jobs, LEASE, Outcome},
};
use crate::{
    database::Database,
    features::{
        configuration::config::{self as pricing_config, Config as StoredConfig},
        inventory_publication::plan::{self, Configuration},
        pricing::{calculator::Stopped, sku_price::Evidence},
    },
};

/// How long after a session without full sales history a continuous batch's SKUs are tried again.
const SALES_HISTORY_RETRY_MINUTES: i32 = 15;

/// A claimed job and what its run has learned so far.
#[derive(Debug)]
pub struct Running {
    pub claimed: Claimed,
    /// The last progress reported, saved with each renewal.
    progress: Mutex<Option<Value>>,
    /// Whether the run stopped because sales history was unavailable.
    sales_history_unavailable: AtomicBool,
}

impl Running {
    pub fn new(claimed: Claimed) -> Self {
        let progress = Mutex::new(claimed.progress_json.clone());
        Running {
            claimed,
            progress,
            sales_history_unavailable: AtomicBool::new(false),
        }
    }

    fn progress(&self) -> Option<Value> {
        self.progress.lock().expect("never poisoned").clone()
    }

    fn report(&self, progress: Value) {
        *self.progress.lock().expect("never poisoned") = Some(progress);
    }
}

/// The pricing configuration a job was queued with.
fn stored(config: &Value) -> StoredConfig {
    StoredConfig::of(
        &config["pricing"],
        &config["supplyAnalysis"],
        &config["productLinePricing"],
    )
}

/// A time as Node writes `new Date()`: to the millisecond.
fn to_millis(at: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(at.timestamp_millis()).expect("a time already in range")
}

/// Saves what `job` priced and completes it, in one transaction, only while `worker` still holds
/// its claim: false, with nothing written, when it does not.
pub async fn save_priced(
    conn: &mut PgConnection,
    job: &Claimed,
    worker: &str,
    mode: Mode,
    priced: &Priced,
    now: DateTime<Utc>,
) -> sqlx::Result<bool> {
    let mut tx = sqlx::Connection::begin(conn).await?;
    let held: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM inventory_batch_pricing_jobs
         WHERE id = $1 AND status = 'pricing' AND claimed_by = $2 FOR UPDATE",
    )
    .bind(job.id)
    .bind(worker)
    .fetch_optional(&mut *tx)
    .await?;
    if held.is_none() {
        return Ok(false);
    }
    let priced_at = to_millis(now);
    let rows = save::rows(&priced.skus, mode, priced_at, &stored(&job.config_json));
    save::save_results(&mut tx, job.batch_number, mode, &rows, priced_at, now).await?;
    let completed = queue::complete(
        &mut tx,
        job.id,
        worker,
        &priced.summary,
        Some(&priced.progress),
    )
    .await?;
    tx.commit().await?;
    Ok(completed)
}

/// What a completed batch changes elsewhere, each failure logged and the rest still done, as
/// Node's worker does: the strategy's curves, the continuous inventory's last pricing, and the
/// publication the batch plans by itself. The strategy's warm-up after new curves is not ported.
pub async fn follow_up(
    conn: &mut PgConnection,
    batch_number: i32,
    current: &StoredConfig,
    now: DateTime<Utc>,
) -> Option<plan::Automatic> {
    if let Err(why) = save::record_successful_batch(conn, batch_number).await {
        eprintln!("Inventory strategy projection update failed for batch {batch_number}: {why}");
    }
    if let Err(why) = save::record_batch_completed(conn, batch_number).await {
        eprintln!("Continuous pricing projection update failed for batch {batch_number}: {why}");
    }
    let planned = async {
        let configuration = Configuration::load(conn).await?;
        let mut tx = sqlx::Connection::begin(&mut *conn).await?;
        let planned =
            plan::plan_automatic(&mut tx, batch_number, &configuration, current, now).await?;
        tx.commit().await?;
        Ok::<_, plan::Error>(planned)
    }
    .await;
    planned
        .inspect_err(|why| {
            eprintln!("Automatic publication planning failed for batch {batch_number}: {why}")
        })
        .ok()
}

/// The pricing jobs in Postgres, priced from `evidence` and `market` by `worker`.
pub struct PricingJobs<E, M> {
    pub db: Database,
    pub worker: String,
    pub evidence: E,
    pub market: M,
}

impl<E, M> PricingJobs<E, M> {
    /// Node's worker is `inventory-batch-worker-{pid}`; this one says it is the port's.
    pub fn worker_id() -> String {
        format!("inventory-batch-worker-rust-{}", std::process::id())
    }

    fn lease_ms() -> i64 {
        LEASE.as_millis() as i64
    }
}

impl<E: Evidence, M: MarketData> Jobs for PricingJobs<E, M> {
    type Job = Running;

    async fn requeue_expired(&self) -> Result<(), String> {
        let mut conn = self.db.0.acquire().await.map_err(|e| e.to_string())?;
        queue::requeue_expired(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn claim(&self) -> Result<Option<Running>, String> {
        let mut tx = self.db.0.begin().await.map_err(|e| e.to_string())?;
        let claimed = queue::claim_next(&mut tx, &self.worker, Self::lease_ms())
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(claimed.map(Running::new))
    }

    async fn renew(&self, job: &Running) -> Result<bool, String> {
        let mut conn = self.db.0.acquire().await.map_err(|e| e.to_string())?;
        let progress = job.progress();
        queue::heartbeat(
            &mut conn,
            job.claimed.id,
            &self.worker,
            Self::lease_ms(),
            progress.as_ref(),
        )
        .await
        .map_err(|e| e.to_string())
    }

    async fn work(&self, job: &Running) -> Result<(), String> {
        let claimed = &job.claimed;
        let mode = Mode::of(&claimed.mode)
            .ok_or_else(|| format!("Unknown pricing mode {}", claimed.mode))?;
        let batch = job::batch(&self.db, claimed.batch_number).await?;
        let config = stored(&claimed.config_json);
        let priced = job::price(
            &self.db,
            &batch,
            mode,
            &config,
            &self.evidence,
            &self.market,
            Utc::now(),
            &mut |progress| job.report(progress),
        )
        .await
        .map_err(|stopped| {
            if matches!(stopped, Stopped::SalesHistoryUnavailable(_)) {
                job.sales_history_unavailable.store(true, Ordering::Relaxed);
            }
            stopped.to_string()
        })?;
        job.report(priced.progress.clone());
        let mut conn = self.db.0.acquire().await.map_err(|e| e.to_string())?;
        if save_priced(&mut conn, claimed, &self.worker, mode, &priced, Utc::now())
            .await
            .map_err(|e| e.to_string())?
        {
            Ok(())
        } else {
            Err("The job's claim ran out before its results were saved.".into())
        }
    }

    async fn finished(&self, job: &Running, outcome: &Outcome) -> Result<(), String> {
        let claimed = &job.claimed;
        let mut conn = self.db.0.acquire().await.map_err(|e| e.to_string())?;
        match outcome {
            Outcome::Completed => {
                let current = pricing_config::load(&self.db)
                    .await
                    .map_err(|e| e.to_string())?;
                follow_up(&mut conn, claimed.batch_number, &current, Utc::now()).await;
            }
            Outcome::Failed(why) => {
                let mut tx = sqlx::Connection::begin(&mut *conn)
                    .await
                    .map_err(|e| e.to_string())?;
                let progress = job.progress();
                queue::fail(&mut tx, claimed.id, &self.worker, why, progress.as_ref())
                    .await
                    .map_err(|e| e.to_string())?;
                if job.sales_history_unavailable.load(Ordering::Relaxed) {
                    // The session, not the SKUs, failed: try them again once it is renewed.
                    save::retry_after(&mut tx, claimed.batch_number, SALES_HISTORY_RETRY_MINUTES)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                tx.commit().await.map_err(|e| e.to_string())?;
            }
            Outcome::Released => {
                queue::release(&mut conn, claimed.id, &self.worker)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Outcome::LeaseLost => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::batch_pricing::shadow::{Ledgers, SavedMarket, saved};

    /// Node's latest completed continuous job, priced again from the ledgers and the market data
    /// Node saved, then saved and followed up as this worker would, inside a transaction that is
    /// rolled back: a worker without the claim writes nothing, the claim's holder replaces the
    /// batch's results, completes the job with its last progress, and plans what the batch plans.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn a_priced_job_is_saved_completed_and_followed_up_under_its_claim() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let finished: crate::features::batch_pricing::shadow::Finished = sqlx::query_as(
            "SELECT j.id, j.batch_number, j.mode, j.config_json, j.started_at, j.completed_at
             FROM inventory_batch_pricing_jobs j JOIN inventory_batches b USING (batch_number)
             WHERE j.status = 'completed' AND j.mode = 'full' AND b.source_type = 'continuous'
             ORDER BY j.id DESC LIMIT 1",
        )
        .fetch_one(&db.0)
        .await
        .unwrap();
        let node = saved(&db, finished.batch_number).await.unwrap();
        let batch = job::batch(&db, finished.batch_number).await.unwrap();
        let config = stored(&finished.config_json);
        let mut steps = Vec::new();
        let priced = job::price(
            &db,
            &batch,
            Mode::Full,
            &config,
            &Ledgers {
                db: &db,
                as_of: finished.completed_at,
            },
            &SavedMarket(&node),
            finished.started_at,
            &mut |step| steps.push(step),
        )
        .await
        .unwrap();
        let phases: Vec<u64> = steps
            .iter()
            .map(|s| s["current"].as_u64().unwrap())
            .collect();
        assert_eq!(phases.first(), Some(&1));
        assert_eq!(phases.last(), Some(&6));
        assert!(
            phases.windows(2).all(|w| w[0] <= w[1]),
            "steps only go forward: {phases:?}"
        );
        assert!(
            steps.iter().any(|s| s["subProgress"]["status"]
                .as_str()
                .is_some_and(|t| t.starts_with("Processing 1/"))),
            "each SKU is reported"
        );

        let mut tx = db.0.begin().await.unwrap();
        let claimed: Claimed = sqlx::query_as(
            "UPDATE inventory_batch_pricing_jobs
             SET status = 'pricing', claimed_by = 'rust-test', claim_expires_at = NOW() + INTERVAL '1 minute'
             WHERE id = $1
             RETURNING id, batch_number, mode, config_json, progress_json, attempt_count, started_at",
        )
        .bind(finished.id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let before: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM inventory_batch_results WHERE batch_number = $1",
        )
        .bind(claimed.batch_number)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let now = Utc::now();
        assert!(
            !save_priced(&mut tx, &claimed, "someone-else", Mode::Full, &priced, now)
                .await
                .unwrap()
        );
        let (status, after): (String, i64) = sqlx::query_as(
            "SELECT j.status, (SELECT COUNT(*) FROM inventory_batch_results WHERE batch_number = j.batch_number)
             FROM inventory_batch_pricing_jobs j WHERE j.id = $1",
        )
        .bind(claimed.id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            (status.as_str(), after),
            ("pricing", before),
            "nothing written without the claim"
        );

        assert!(
            save_priced(&mut tx, &claimed, "rust-test", Mode::Full, &priced, now)
                .await
                .unwrap()
        );
        let (status, progress, results, batch_status, priced_at): (String, Value, i64, String, DateTime<Utc>) =
            sqlx::query_as(
                "SELECT j.status, j.progress_json,
                        (SELECT COUNT(*) FROM inventory_batch_results WHERE batch_number = j.batch_number),
                        b.status, b.last_priced_at
                 FROM inventory_batch_pricing_jobs j JOIN inventory_batches b USING (batch_number)
                 WHERE j.id = $1",
            )
            .bind(claimed.id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(progress["phase"], "Complete");
        assert_eq!(results as usize, priced.skus.len());
        assert_eq!(batch_status, "priced");
        assert_eq!(priced_at, to_millis(now));

        let current = pricing_config::load(&db).await.unwrap();
        let planned = follow_up(&mut tx, claimed.batch_number, &current, now).await;
        println!(
            "batch {}: {} SKUs saved; follow-up planned {planned:?}",
            claimed.batch_number,
            priced.skus.len()
        );
        assert!(planned.is_some(), "planning ran without an error");
        tx.rollback().await.unwrap();
    }
}
