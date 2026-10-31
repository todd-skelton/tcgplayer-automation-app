//! The pricing jobs queue (`inventoryBatchPricingJobsRepository`): the worker claims the most urgent
//! queued job with a lease, renews it while it prices, and marks it completed or failed; a job
//! whose lease ran out goes back to the queue. The batch's own status follows its job.
//!
//! Each call takes a connection, so a caller can run it inside a transaction of its own.
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgConnection;

/// A claimed job.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Claimed {
    pub id: i64,
    pub batch_number: i32,
    pub mode: String,
    pub config_json: Value,
    pub progress_json: Option<Value>,
    /// How many times the job has been claimed, this one included; the queue's tests read it.
    #[allow(dead_code, reason = "read by the queue's tests")]
    pub attempt_count: i32,
    #[allow(dead_code, reason = "claimed as Node's repository returns it")]
    pub started_at: Option<DateTime<Utc>>,
}

/// Puts back every job whose lease ran out mid-pricing; how many.
pub async fn requeue_expired(conn: &mut PgConnection) -> sqlx::Result<u64> {
    let batches: Vec<i32> = sqlx::query_scalar(
        "UPDATE inventory_batch_pricing_jobs
         SET status = 'queued', claimed_by = NULL, claim_expires_at = NULL, updated_at = NOW()
         WHERE status = 'pricing' AND claim_expires_at IS NOT NULL AND claim_expires_at < NOW()
         RETURNING batch_number",
    )
    .fetch_all(&mut *conn)
    .await?;
    if !batches.is_empty() {
        sqlx::query(
            "UPDATE inventory_batches SET status = 'queued', updated_at = NOW()
             WHERE batch_number = ANY($1)",
        )
        .bind(&batches)
        .execute(&mut *conn)
        .await?;
    }
    Ok(batches.len() as u64)
}

/// Claims the most urgent queued job for `worker` for `lease_ms`, oldest first among equals;
/// none when the queue is empty. Run it in a transaction: the job and its batch move together.
pub async fn claim_next(
    conn: &mut PgConnection,
    worker: &str,
    lease_ms: i64,
) -> sqlx::Result<Option<Claimed>> {
    let claimed: Option<Claimed> = sqlx::query_as(
        "WITH next_job AS (
            SELECT id FROM inventory_batch_pricing_jobs
            WHERE status = 'queued'
            ORDER BY priority DESC, created_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE inventory_batch_pricing_jobs job
         SET status = 'pricing',
             claimed_by = $1,
             claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         FROM next_job
         WHERE job.id = next_job.id
         RETURNING job.id, job.batch_number, job.mode, job.config_json, job.progress_json,
                   job.attempt_count, job.started_at",
    )
    .bind(worker)
    .bind(lease_ms as f64)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(job) = &claimed {
        sqlx::query(
            "UPDATE inventory_batches SET status = 'pricing', updated_at = NOW() WHERE batch_number = $1",
        )
        .bind(job.batch_number)
        .execute(&mut *conn)
        .await?;
    }
    Ok(claimed)
}

/// Renews `worker`'s lease on the job, saving its progress when given; nothing when the job is no
/// longer `worker`'s.
pub async fn heartbeat(
    conn: &mut PgConnection,
    job: i64,
    worker: &str,
    lease_ms: i64,
    progress: Option<&Value>,
) -> sqlx::Result<bool> {
    let renewed = sqlx::query(
        "UPDATE inventory_batch_pricing_jobs
         SET claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
             progress_json = COALESCE($4::jsonb, progress_json),
             updated_at = NOW()
         WHERE id = $1 AND status = 'pricing' AND claimed_by = $2",
    )
    .bind(job)
    .bind(worker)
    .bind(lease_ms as f64)
    .bind(progress)
    .execute(&mut *conn)
    .await?;
    Ok(renewed.rows_affected() == 1)
}

/// Gives `worker`'s claim back, so the next worker takes the job at once (shutdown mid-job).
pub async fn release(conn: &mut PgConnection, job: i64, worker: &str) -> sqlx::Result<bool> {
    let batch: Option<i32> = sqlx::query_scalar(
        "UPDATE inventory_batch_pricing_jobs
         SET status = 'queued', claimed_by = NULL, claim_expires_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'pricing' AND claimed_by = $2
         RETURNING batch_number",
    )
    .bind(job)
    .bind(worker)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(batch) = batch {
        sqlx::query("UPDATE inventory_batches SET status = 'queued', updated_at = NOW() WHERE batch_number = $1")
            .bind(batch)
            .execute(&mut *conn)
            .await?;
    }
    Ok(batch.is_some())
}

/// `worker`'s job priced: its summary and last progress kept, its lease dropped; false when the
/// job is no longer `worker`'s (its lease ran out and another worker may hold it), and nothing is
/// written.
pub async fn complete(
    conn: &mut PgConnection,
    job: i64,
    worker: &str,
    summary: &Value,
    progress: Option<&Value>,
) -> sqlx::Result<bool> {
    let completed = sqlx::query(
        "UPDATE inventory_batch_pricing_jobs
         SET status = 'completed', summary_json = $3::jsonb,
             progress_json = COALESCE($4::jsonb, progress_json), error_message = NULL,
             claim_expires_at = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pricing' AND claimed_by = $2",
    )
    .bind(job)
    .bind(worker)
    .bind(summary)
    .bind(progress)
    .execute(&mut *conn)
    .await?;
    Ok(completed.rows_affected() == 1)
}

/// `worker`'s job failed with `error`, and so did its batch; false when the job is no longer
/// `worker`'s, and nothing is written. Run it in a transaction.
pub async fn fail(
    conn: &mut PgConnection,
    job: i64,
    worker: &str,
    error: &str,
    progress: Option<&Value>,
) -> sqlx::Result<bool> {
    let batch: Option<i32> = sqlx::query_scalar(
        "UPDATE inventory_batch_pricing_jobs
         SET status = 'failed', error_message = $3,
             progress_json = COALESCE($4::jsonb, progress_json),
             claim_expires_at = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pricing' AND claimed_by = $2
         RETURNING batch_number",
    )
    .bind(job)
    .bind(worker)
    .bind(error)
    .bind(progress)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(batch) = batch {
        sqlx::query("UPDATE inventory_batches SET status = 'failed', updated_at = NOW() WHERE batch_number = $1")
            .bind(batch)
            .execute(&mut *conn)
            .await?;
    }
    Ok(batch.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    async fn status(conn: &mut PgConnection, job: i64) -> (String, Option<String>, i32) {
        sqlx::query_as(
            "SELECT status, claimed_by, attempt_count FROM inventory_batch_pricing_jobs WHERE id = $1",
        )
        .bind(job)
        .fetch_one(conn)
        .await
        .unwrap()
    }

    async fn batch_status(conn: &mut PgConnection, batch: i32) -> String {
        sqlx::query_scalar("SELECT status FROM inventory_batches WHERE batch_number = $1")
            .bind(batch)
            .fetch_one(conn)
            .await
            .unwrap()
    }

    /// A job's life on the dev database, inside a transaction that is rolled back: queued jobs
    /// are moved out of the way, one is queued, claimed, renewed, expired, requeued, claimed again
    /// and completed; another fails.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn a_job_is_claimed_renewed_requeued_and_finished() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        // Nothing else is queued within the transaction, so the claim takes this test's job.
        sqlx::query("UPDATE inventory_batch_pricing_jobs SET status = 'held' WHERE status IN ('queued', 'pricing')")
            .execute(&mut *tx)
            .await
            .unwrap();
        let batch: i32 = sqlx::query_scalar("SELECT MAX(batch_number) FROM inventory_batches")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let queue = |priority: i32| {
            sqlx::query_scalar::<_, i64>(
                "INSERT INTO inventory_batch_pricing_jobs (batch_number, priority, mode, status, config_json)
                 VALUES ($1, $2, 'full', 'queued', '{}'::jsonb) RETURNING id",
            )
            .bind(batch)
            .bind(priority)
        };
        let routine = queue(0).fetch_one(&mut *tx).await.unwrap();
        let urgent = queue(300).fetch_one(&mut *tx).await.unwrap();

        let claimed = claim_next(&mut tx, "rust-test", 15_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, urgent, "the most urgent job first");
        assert_eq!(
            status(&mut tx, urgent).await,
            ("pricing".into(), Some("rust-test".into()), 1)
        );
        assert_eq!(batch_status(&mut tx, batch).await, "pricing");

        let progress = serde_json::json!({ "current": 4, "total": 6 });
        assert!(
            heartbeat(&mut tx, urgent, "rust-test", 15_000, Some(&progress))
                .await
                .unwrap()
        );
        assert!(
            !heartbeat(&mut tx, urgent, "someone-else", 15_000, None)
                .await
                .unwrap()
        );

        sqlx::query("UPDATE inventory_batch_pricing_jobs SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1")
            .bind(urgent)
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(requeue_expired(&mut tx).await.unwrap(), 1);
        assert_eq!(status(&mut tx, urgent).await, ("queued".into(), None, 1));
        assert_eq!(batch_status(&mut tx, batch).await, "queued");

        let again = claim_next(&mut tx, "rust-test", 15_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((again.id, again.attempt_count), (urgent, 2));
        assert!(!release(&mut tx, urgent, "someone-else").await.unwrap());
        assert!(release(&mut tx, urgent, "rust-test").await.unwrap());
        assert_eq!(status(&mut tx, urgent).await, ("queued".into(), None, 2));
        let again = claim_next(&mut tx, "rust-test", 15_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((again.id, again.attempt_count), (urgent, 3));
        assert_eq!(
            again.progress_json,
            Some(progress.clone()),
            "progress kept through the requeue"
        );
        let summary = serde_json::json!({ "totalRows": 1 });
        assert!(
            !complete(&mut tx, urgent, "someone-else", &summary, None)
                .await
                .unwrap(),
            "a worker whose lease ran out writes nothing"
        );
        assert_eq!(status(&mut tx, urgent).await.0, "pricing");
        assert!(
            complete(&mut tx, urgent, "rust-test", &summary, None)
                .await
                .unwrap()
        );
        assert_eq!(status(&mut tx, urgent).await.0, "completed");

        let next = claim_next(&mut tx, "rust-test", 15_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next.id, routine);
        assert!(
            !fail(&mut tx, routine, "someone-else", "boom", None)
                .await
                .unwrap()
        );
        assert_eq!(batch_status(&mut tx, batch).await, "pricing");
        assert!(
            fail(&mut tx, routine, "rust-test", "boom", None)
                .await
                .unwrap()
        );
        assert_eq!(status(&mut tx, routine).await.0, "failed");
        assert_eq!(batch_status(&mut tx, batch).await, "failed");
        assert!(
            claim_next(&mut tx, "rust-test", 15_000)
                .await
                .unwrap()
                .is_none()
        );
        tx.rollback().await.unwrap();
    }
}
