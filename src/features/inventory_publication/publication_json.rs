//! Publications as the Node app's JSON routes answer them (`inventoryPublicationsRepository`):
//! each row with its items, as node-pg hands them over (`crate::node_pg`), from Node's SQL as
//! written, with the ids made numbers as `normalizePublicationRow` makes them.
use serde_json::Value;
use sqlx::PgConnection;

use crate::node_pg;

/// `publicationSelect`.
const PUBLICATION: &str = r#"SELECT
  id,
  planning_key AS "planningKey",
  batch_number AS "batchNumber",
  pricing_job_id AS "pricingJobId",
  method,
  source_type AS "sourceType",
  seller_key AS "sellerKey",
  status,
  staged_pricing_upload_id AS "stagedPricingUploadId",
  config_json AS "config",
  progress_json AS "progress",
  error_code AS "errorCode",
  error_message AS "errorMessage",
  attempt_count AS "attemptCount",
  claimed_by AS "claimedBy",
  claim_expires_at AS "claimExpiresAt",
  staged_at AS "stagedAt",
  publishing_at AS "publishingAt",
  published_at AS "publishedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
FROM inventory_publications"#;

/// `publicationItemSelect`.
const ITEM: &str = r#"SELECT
  id,
  publication_id AS "publicationId",
  candidate_key AS "candidateKey",
  inventory_delta_key AS "inventoryDeltaKey",
  batch_number AS "batchNumber",
  sku,
  product_id AS "productId",
  product_line AS "productLine",
  set_name AS "setName",
  product_name AS "productName",
  condition,
  previous_price::float8 AS "previousPrice",
  desired_price::float8 AS "desiredPrice",
  quantity_delta AS "quantityDelta",
  observed_quantity AS "observedQuantity",
  desired_absolute_quantity AS "desiredAbsoluteQuantity",
  priced_at AS "pricedAt",
  eligibility_reasons AS "eligibilityReasons",
  forecast_evidence AS "forecastEvidence",
  forecast_evidence_provenance AS "forecastEvidenceProvenance",
  status,
  error_code AS "errorCode",
  error_message AS "errorMessage",
  published_at AS "publishedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
FROM inventory_publication_items"#;

/// `findByBatchNumber`: the batch's publications, newest first, each with its items.
pub async fn for_batch(conn: &mut PgConnection, batch_number: i32) -> Result<Value, String> {
    let rows = sqlx::query(&format!(
        "{PUBLICATION}
      WHERE batch_number = $1
      ORDER BY created_at DESC, id DESC"
    ))
    .bind(batch_number)
    .fetch_all(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let mut publications = Vec::with_capacity(rows.len());
    for row in &rows {
        publications.push(with_items(conn, node_pg::row(row)?).await?);
    }
    Ok(Value::Array(publications))
}

/// `findById` of each, in order; one not there is `null`.
pub async fn by_ids(conn: &mut PgConnection, ids: &[i64]) -> Result<Value, String> {
    let mut publications = Vec::with_capacity(ids.len());
    for id in ids {
        let row = sqlx::query(&format!("{PUBLICATION}\n      WHERE id = $1"))
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(node_pg::thrown)?;
        publications.push(match row {
            Some(row) => with_items(conn, node_pg::row(&row)?).await?,
            None => Value::Null,
        });
    }
    Ok(Value::Array(publications))
}

/// `attachItems`: the publication's items in the order they were planned.
async fn with_items(conn: &mut PgConnection, mut publication: Value) -> Result<Value, String> {
    numbered(&mut publication, &["id", "pricingJobId"])?;
    let id = publication["id"].as_i64().unwrap_or_default();
    let rows = sqlx::query(&format!(
        "{ITEM}
    WHERE publication_id = $1
    ORDER BY id"
    ))
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut item = node_pg::row(row)?;
        numbered(&mut item, &["id", "publicationId"])?;
        items.push(item);
    }
    publication["items"] = Value::Array(items);
    Ok(publication)
}

/// `safeDatabaseId`: an `int8` id node-pg handed over as text, as the number it is.
fn numbered(row: &mut Value, keys: &[&str]) -> Result<(), String> {
    for key in keys {
        if let Value::String(text) = &row[*key] {
            let id: i64 = text
                .parse()
                .map_err(|_| format!("Error: {key} is outside the supported integer range."))?;
            row[*key] = id.into();
        }
    }
    Ok(())
}
