//! A batch as the Node app's JSON routes answer it (`inventoryBatchesRepository.findByBatchNumber`):
//! its row and its latest pricing job, each as node-pg hands it over (`crate::node_pg`), from
//! Node's SQL as written.
use serde_json::Value;
use sqlx::PgConnection;

use crate::node_pg;

/// `batchSelect`, every batch's row and its item count.
macro_rules! batch_select {
    ($rest:literal) => {
        concat!(
            r#"SELECT
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
"#,
            $rest
        )
    };
}

/// `findRecent` of the batches made by hand: the Inventory Manager's, a seller's and a CSV's.
const RECENT: &str = batch_select!(
    r#"      WHERE b.source_type = ANY($1::text[])
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
  b.manual_review_count
      ORDER BY b.batch_number DESC
      LIMIT $2"#
);

/// `findLatestByBatchNumbers`: each batch's newest pricing job.
const LATEST_JOBS: &str = r#"SELECT DISTINCT ON (batch_number)
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
      WHERE batch_number = ANY($1::int[])
      ORDER BY batch_number, created_at DESC, id DESC"#;

/// `findItems`: the batch's items, or with `errors` those its last pricing did not price.
const ITEMS: &str = r#"SELECT
        i.batch_number AS "batchNumber",
        i.sku,
        i.total_quantity AS "totalQuantity",
        i.add_to_quantity AS "addToQuantity",
        i.current_price::float8 AS "currentPrice",
        i.product_line_id AS "productLineId",
        i.set_id AS "setId",
        i.product_id AS "productId",
        i.original_row_json AS "originalRow",
        i.created_at AS "createdAt",
        i.updated_at AS "updatedAt"
      FROM inventory_batch_items i
      WHERE i.batch_number = $1
      "#;

const ERRORS: &str = r#"AND i.sku > 0
          AND (i.total_quantity > 0 OR i.add_to_quantity > 0)
          AND EXISTS (
            SELECT 1
            FROM inventory_batch_results r
            WHERE r.batch_number = i.batch_number
              AND r.sku = i.sku
              AND r.result_status <> 'successful'
          )"#;

/// The newest 100 batches made by hand, each with its `latestJob` (`null` before any). An error
/// is what node-pg threw, as `String(error)` writes it.
pub async fn recent(conn: &mut PgConnection) -> Result<Value, String> {
    let rows = sqlx::query(RECENT)
        .bind(["pending_inventory", "seller", "csv"])
        .bind(100_i32)
        .fetch_all(&mut *conn)
        .await
        .map_err(node_pg::thrown)?;
    let mut batches: Vec<Value> = rows.iter().map(node_pg::row).collect::<Result<_, _>>()?;
    let numbers: Vec<i32> = batches
        .iter()
        .filter_map(|b| b["batchNumber"].as_i64())
        .filter_map(|n| i32::try_from(n).ok())
        .collect();
    let jobs = sqlx::query(LATEST_JOBS)
        .bind(&numbers)
        .fetch_all(&mut *conn)
        .await
        .map_err(node_pg::thrown)?;
    let mut latest = std::collections::HashMap::new();
    for job in &jobs {
        let job = node_pg::row(job)?;
        latest.insert(job["batchNumber"].as_i64(), job);
    }
    for batch in &mut batches {
        batch["latestJob"] = latest
            .remove(&batch["batchNumber"].as_i64())
            .unwrap_or(Value::Null);
    }
    Ok(Value::Array(batches))
}

/// The batch's items in the order they were counted, or with `errors` only those whose last
/// pricing did not succeed. A batch that is not there has none.
pub async fn items(
    conn: &mut PgConnection,
    batch_number: i32,
    errors: bool,
) -> Result<Value, String> {
    let filter = if errors { ERRORS } else { "" };
    let rows = sqlx::query(&format!(
        "{ITEMS}{filter}
      ORDER BY i.created_at, i.sku"
    ))
    .bind(batch_number)
    .fetch_all(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    node_pg::rows(&rows)
}

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
    let failed = node_pg::thrown;
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
