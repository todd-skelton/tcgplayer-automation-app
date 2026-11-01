//! A batch as the Node app's JSON routes answer it (`inventoryBatchesRepository.findByBatchNumber`):
//! its row and its latest pricing job, each as node-pg hands it over (`crate::node_pg`), from
//! Node's SQL as written.
use serde_json::Value;
use sqlx::PgConnection;

use crate::node_pg;

const BATCH: &str = r#"SELECT
  b.batch_number AS "batchNumber",
  b.status,
  b.source_type AS "sourceType",
  b.source_label AS "sourceLabel",
  b.created_at AS "createdAt",
  b.updated_at AS "updatedAt",
  b.last_priced_at AS "lastPricedAt",
  b.summary_json AS "summary",
  b.successful_count AS "successfulCount",
  b.manual_review_count AS "manualReviewCount",
  COUNT(i.sku)::int AS "itemCount"
FROM inventory_batches b
LEFT JOIN inventory_batch_items i
  ON i.batch_number = b.batch_number
      WHERE b.batch_number = $1
      GROUP BY
  b.batch_number,
  b.status,
  b.source_type,
  b.source_label,
  b.created_at,
  b.updated_at,
  b.last_priced_at,
  b.summary_json,
  b.successful_count,
  b.manual_review_count"#;

const LATEST_JOB: &str = r#"SELECT
  id,
  batch_number AS "batchNumber",
  priority,
  mode,
  status,
  config_json AS "config",
  progress_json AS "progress",
  summary_json AS "summary",
  error_message AS "errorMessage",
  attempt_count AS "attemptCount",
  claimed_by AS "claimedBy",
  claim_expires_at AS "claimExpiresAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
FROM inventory_batch_pricing_jobs
      WHERE batch_number = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1"#;

/// The batch with its `latestJob` (`null` before any), or none when there is no such batch.
pub async fn find(conn: &mut PgConnection, batch_number: i32) -> Result<Option<Value>, String> {
    let failed = |e: sqlx::Error| e.to_string();
    let Some(row) = sqlx::query(BATCH)
        .bind(batch_number)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?
    else {
        return Ok(None);
    };
    let mut batch = node_pg::row(&row)?;
    let job = sqlx::query(LATEST_JOB)
        .bind(batch_number)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
    batch["latestJob"] = match job {
        Some(job) => node_pg::row(&job)?,
        None => Value::Null,
    };
    Ok(Some(batch))
}
