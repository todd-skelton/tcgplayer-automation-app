//! The pages an operator reads of an opening balance (`inventoryOpeningBalancesRepository`'s
//! `listDifferences`, `listApplicationDifferences`, `listObservationItems`,
//! `listPreviewItems`), with Node's queries, so the answers are its own (`crate::node_pg`).
//!
//! node-pg sent each value as text for Postgres to read as its column's type, so an ID or cursor
//! is bound as text and cast in the query: one Postgres cannot read is refused with the message
//! Node's was. An error is `String(error)`, as the Node route answered it.
use serde_json::Value;
use sqlx::PgExecutor;

use crate::{features::inventory_economics::ledger::fingerprint::js_float, node_pg};

const DIFFERENCES: &str = r#"SELECT id::text AS id,inventory_key AS "inventoryKey",sku,previous_quantity AS "previousQuantity",
      observed_quantity AS "observedQuantity",quantity_delta AS "quantityDelta",status,
      acknowledgement_note AS "acknowledgementNote",acknowledged_at AS "acknowledgedAt"
      FROM inventory_observation_differences
      WHERE seller_key=$1 AND observation_id=$2::text::bigint AND id>$3::text::bigint
      ORDER BY id LIMIT $4"#;

const APPLICATION_DIFFERENCES: &str = r#"SELECT difference.id::text AS id,difference.observation_id::text AS "observationId",
      difference.inventory_key AS "inventoryKey",difference.sku,
      difference.previous_quantity AS "previousQuantity",difference.observed_quantity AS "observedQuantity",
      difference.quantity_delta AS "quantityDelta",difference.status,
      difference.acknowledgement_note AS "acknowledgementNote",
      difference.acknowledged_at AS "acknowledgedAt"
      FROM inventory_opening_balance_runs run
      JOIN inventory_complete_observations validation
        ON validation.id=$3::text::bigint AND validation.seller_key=run.seller_key
      JOIN inventory_complete_observations observation
        ON observation.seller_key=run.seller_key
        AND observation.cutoff_at>run.cutoff_at AND observation.cutoff_at<=validation.cutoff_at
      JOIN inventory_observation_differences difference
        ON difference.observation_id=observation.id AND difference.sku IS NOT NULL
      WHERE run.id=$1::text::bigint AND run.seller_key=$2 AND difference.id>$4::text::bigint
      ORDER BY difference.id LIMIT $5"#;

const OBSERVATION_ITEMS: &str = r#"SELECT item.inventory_key AS "inventoryKey",item.identity_kind AS "identityKind",
      item.sku,item.quantity
      FROM inventory_complete_observation_items item
      JOIN inventory_complete_observations observation ON observation.id=item.observation_id
      WHERE observation.id=$1::text::bigint AND observation.seller_key=$2
        AND item.inventory_key COLLATE "C">$3 COLLATE "C"
        AND (NOT $4::boolean OR item.identity_kind='unsupported')
      ORDER BY item.inventory_key COLLATE "C" LIMIT $5"#;

const PREVIEW_ITEMS: &str = r#"SELECT item.sku,item.opening_quantity AS "openingQuantity",
      item.product_line_id AS "productLineId",item.set_id AS "setId",item.product_id AS "productId"
      FROM inventory_opening_balance_items item
      JOIN inventory_opening_balance_runs run ON run.id=item.run_id
      WHERE run.id=$1::text::bigint AND run.seller_key=$2 AND item.sku>$3::text::integer
      ORDER BY item.sku LIMIT $4"#;

/// A page's size, 100 when not given: a whole number from 1 to 200, or Node's error naming the page.
fn limit(limit: Option<f64>, page: &str) -> Result<i64, String> {
    match limit.unwrap_or(100.0) {
        n if n.fract() == 0.0 && (1.0..=200.0).contains(&n) => Ok(n as i64),
        _ => Err(format!(
            "Error: {page} page limit must be between 1 and 200."
        )),
    }
}

fn rows(read: sqlx::Result<Vec<sqlx::postgres::PgRow>>) -> Result<Value, String> {
    node_pg::rows(&read.map_err(node_pg::thrown)?)
}

/// An observation's differences after the one `after` (by ID).
pub async fn differences(
    db: impl PgExecutor<'_>,
    seller: &str,
    observation: &str,
    after: Option<&str>,
    page: Option<f64>,
) -> Result<Value, String> {
    let page = limit(page, "Difference")?;
    let read = sqlx::query(DIFFERENCES)
        .bind(seller.trim())
        .bind(observation)
        .bind(after.unwrap_or("0"))
        .bind(page)
        .fetch_all(db)
        .await;
    rows(read)
}

/// The differences observed between a run's cutoff and its validation's, after `after` (by ID).
pub async fn application_differences(
    db: impl PgExecutor<'_>,
    seller: &str,
    run: &str,
    validation: &str,
    after: Option<&str>,
    page: Option<f64>,
) -> Result<Value, String> {
    let page = limit(page, "Application difference")?;
    let read = sqlx::query(APPLICATION_DIFFERENCES)
        .bind(run)
        .bind(seller.trim())
        .bind(validation)
        .bind(after.unwrap_or("0"))
        .bind(page)
        .fetch_all(db)
        .await;
    rows(read)
}

/// An observation's items after the inventory key `after`, only those it could not identify when
/// `unsupported_only`.
pub async fn observation_items(
    db: impl PgExecutor<'_>,
    seller: &str,
    observation: &str,
    after: Option<&str>,
    page: Option<f64>,
    unsupported_only: Option<bool>,
) -> Result<Value, String> {
    let page = limit(page, "Observation item")?;
    let read = sqlx::query(OBSERVATION_ITEMS)
        .bind(observation)
        .bind(seller.trim())
        .bind(after.unwrap_or(""))
        .bind(unsupported_only.unwrap_or(false))
        .bind(page)
        .fetch_all(db)
        .await;
    rows(read)
}

/// A run's opening quantities after the SKU `after`, a number sent as JavaScript writes it.
pub async fn preview_items(
    db: impl PgExecutor<'_>,
    seller: &str,
    run: &str,
    after: Option<f64>,
    page: Option<f64>,
) -> Result<Value, String> {
    let page = limit(page, "Preview item")?;
    let read = sqlx::query(PREVIEW_ITEMS)
        .bind(run)
        .bind(seller.trim())
        .bind(js_float(after.unwrap_or(0.0)))
        .bind(page)
        .fetch_all(db)
        .await;
    rows(read)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::database::Database;

    /// The differences `.port-logs/opening-balance-seed.sql` adds, read in a transaction rolled
    /// back, page as Node's did (`.port-logs/opening-balance-node.ts`).
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's pages in .port-logs"]
    async fn differences_page_as_node_pages_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let node: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/opening-balance.node.json").unwrap(),
        )
        .unwrap();
        let seed = std::fs::read_to_string(".port-logs/opening-balance-seed.sql").unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&seed).execute(&mut *tx).await.unwrap();
        let first: String =
            sqlx::query_scalar("SELECT min(id)::text FROM inventory_observation_differences")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        for case in &node {
            let input = &case["input"];
            let text = |key: &str| input[key].as_str();
            // The first difference's ID differs from run to run.
            let after = text("afterId").map(|_| first.as_str());
            let seller = text("sellerKey").unwrap();
            let limit = input["limit"].as_f64();
            let ours = match case["call"].as_str().unwrap() {
                "differences" => {
                    let observation = text("observationId").unwrap();
                    differences(&mut *tx, seller, observation, after, limit).await
                }
                _ => {
                    let (run, validation) = (
                        text("runId").unwrap(),
                        text("validationObservationId").unwrap(),
                    );
                    application_differences(&mut *tx, seller, run, validation, after, limit).await
                }
            };
            let mut ours = ours.unwrap();
            let mut theirs = case["rows"].clone();
            for rows in [&mut ours, &mut theirs] {
                for row in rows.as_array_mut().unwrap() {
                    row["id"] = Value::Null;
                }
            }
            assert_eq!(ours, theirs, "{case}");
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn a_page_holds_from_1_to_200() {
        assert_eq!(limit(None, "Preview item"), Ok(100));
        assert_eq!(limit(Some(200.0), "Preview item"), Ok(200));
        for refused in [0.0, 201.0, 1.5, -1.0] {
            assert_eq!(
                limit(Some(refused), "Preview item"),
                Err("Error: Preview item page limit must be between 1 and 200.".into())
            );
        }
    }
}
