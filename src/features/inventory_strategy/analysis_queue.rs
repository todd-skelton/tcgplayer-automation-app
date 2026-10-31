//! A strategy analysis queued (`queueInventoryStrategyAnalysis`): the seller's in-stock snapshot
//! frozen as a strategy batch and queued for pricing in full, unless one of the seller's is
//! already queued or pricing. The Node app saved the batch and queued it in two transactions;
//! here both are one.
use chrono::{DateTime, DurationRound, TimeDelta, Utc};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;

use super::snapshot::{self, SnapshotItem};
use crate::{
    database::Database,
    features::{
        batch_pricing::{
            imported::{self, Item, refused},
            queue,
        },
        continuous_pricing::{scheduler, store},
        inventory_economics::ledger::{fingerprint::js_float, proceeds::iso},
    },
};

/// The analysis queued, or the one already queued or pricing.
#[derive(Clone, Debug, PartialEq)]
pub struct Queued {
    pub batch_number: i32,
    pub item_count: i64,
    pub status: String,
    pub created: bool,
}

/// `toOriginalRow`: the SKU as a CSV export would list it, with nothing priced yet.
fn original_row(item: &SnapshotItem) -> Map<String, Value> {
    let price = |p: Option<f64>| p.map_or_else(String::new, js_float);
    let row = json!({
        "TCGplayer Id": item.sku.to_string(),
        "Product Line": item.product_line,
        "Set Name": item.set_name,
        "Product": item.product_name,
        "Sku Variant": item.variant,
        "Sku Condition": item.condition,
        "Sale Count": "",
        "Lowest Sale Price": "",
        "Highest Sale Price": "",
        "TCG Market Price": price(item.market_price),
        "Total Quantity": item.quantity.to_string(),
        "Add to Quantity": "0",
        "TCG Marketplace Price": price(item.current_price),
        "Previous Price": "",
        "Suggested Price": "",
        "Percentile Used": "",
        "Historical Sales Velocity (Days)": "",
        "Estimated Time to Sell (Days)": "",
        "Sales Count for Historical Calculation": "",
        "Listings Count for Estimated Calculation": "",
        "Warning": "",
        "Error": "",
    });
    match row {
        Value::Object(fields) => fields,
        _ => Map::new(),
    }
}

/// A batch's status and item count.
async fn counted(conn: &mut PgConnection, batch: i32) -> Result<(String, i64), String> {
    sqlx::query_as(
        "SELECT b.status, COUNT(i.sku) FROM inventory_batches b
         LEFT JOIN inventory_batch_items i ON i.batch_number = b.batch_number
         WHERE b.batch_number = $1 GROUP BY b.batch_number",
    )
    .bind(batch)
    .fetch_one(&mut *conn)
    .await
    .map_err(refused)
}

/// The pricing configuration the analysis is queued with: the whole stored configuration, with
/// when it was saved (`pricingConfigRepository.get()`).
async fn config(db: &Database) -> Result<Value, String> {
    let mut config = scheduler::job_config(db).await.map_err(refused)?;
    let saved: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT updated_at FROM pricing_config WHERE config_key = 'default'")
            .fetch_optional(&db.0)
            .await
            .map_err(refused)?;
    if let (Some(saved), Some(fields)) = (saved, config.as_object_mut()) {
        fields.insert("updatedAt".into(), Value::String(iso(saved)));
    }
    Ok(config)
}

/// The configured seller's analysis, queued now or already running; why not when there is no
/// seller or no snapshot.
pub async fn queue_analysis(db: &Database) -> Result<Queued, String> {
    let seller = store::settings(db).await.map_err(refused)?.seller_key;
    if seller.is_empty() {
        return Err("Configure a seller key first.".into());
    }
    let now = Utc::now()
        .duration_trunc(TimeDelta::milliseconds(1))
        .unwrap_or_else(|_| Utc::now());
    let mut tx = db.0.begin().await.map_err(refused)?;
    let queued = queue(&mut tx, db, &seller, now).await?;
    tx.commit().await.map_err(refused)?;
    Ok(queued)
}

/// The seller's analysis queued in `conn`'s transaction; the snapshot and configuration are read
/// from `db`.
async fn queue(
    conn: &mut PgConnection,
    db: &Database,
    seller: &str,
    now: DateTime<Utc>,
) -> Result<Queued, String> {
    let active: Option<i32> = sqlx::query_scalar(
        "SELECT batch_number FROM (
           SELECT batch_number, source_label, status FROM inventory_batches
           WHERE source_type = 'strategy' ORDER BY batch_number DESC LIMIT 25
         ) recent
         WHERE source_label = $1 AND status IN ('queued', 'pricing')
         ORDER BY batch_number DESC LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&mut *conn)
    .await
    .map_err(refused)?;
    if let Some(batch_number) = active {
        let (status, item_count) = counted(conn, batch_number).await?;
        return Ok(Queued {
            batch_number,
            item_count,
            status,
            created: false,
        });
    }
    let snapshot = snapshot::find(db, seller).await.map_err(refused)?;
    if snapshot.is_empty() {
        return Err("No in-stock inventory snapshot is available. Refresh inventory first.".into());
    }
    let items: Vec<Item> = snapshot
        .iter()
        .map(|item| Item {
            sku: item.sku as f64,
            total_quantity: item.quantity as f64,
            add_to_quantity: 0.0,
            current_price: item.current_price,
            product_line_id: item.product_line_id as i32,
            set_id: item.set_id as i32,
            product_id: item.product_id as i32,
            original_row: original_row(item),
        })
        .collect();
    let config = config(db).await?;
    let batch_number = imported::create(conn, "strategy", seller, &items, now).await?;
    queue::create_or_reuse(conn, batch_number, "full", &config)
        .await
        .map_err(refused)?;
    let (status, item_count) = counted(conn, batch_number).await?;
    Ok(Queued {
        batch_number,
        item_count,
        status,
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Queuing twice on the dev database, inside a transaction rolled back, against Node's run of
    /// `queueInventoryStrategyAnalysis` (`.port-logs/strategy-queue-node.ts`): the batch, every
    /// item with its row, and the job with its configuration are the same, and the second queue
    /// names the first.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's run in .port-logs"]
    async fn an_analysis_queues_as_node_queues_it() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/strategy-queue.node.json").unwrap(),
        )
        .unwrap();
        let capture = std::fs::read_to_string(".port-logs/strategy-queue-capture.sql").unwrap();
        let seller = node["seller"].as_str().unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('inventory_batch_pricing_jobs tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE inventory_batches SET status = 'priced'
             WHERE source_type = 'strategy' AND status IN ('queued', 'pricing')",
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let first = queue(&mut tx, &db, seller, Utc::now()).await.unwrap();
        let second = queue(&mut tx, &db, seller, Utc::now()).await.unwrap();
        let captured: Value = sqlx::query_scalar(&capture)
            .bind(first.batch_number)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        let said = |q: &Queued| {
            json!({ "itemCount": q.item_count, "status": q.status, "created": q.created,
                    "same": q.batch_number == first.batch_number })
        };
        assert_eq!(said(&first), node["first"]);
        assert_eq!(said(&second), node["second"]);
        assert_eq!(captured["batch"], node["captured"]["batch"]);
        assert_eq!(captured["jobs"], node["captured"]["jobs"]);
        let (ours, theirs) = (
            captured["items"].as_array().unwrap(),
            node["captured"]["items"].as_array().unwrap(),
        );
        assert_eq!(ours.len(), theirs.len());
        for (ours, theirs) in ours.iter().zip(theirs) {
            assert_eq!(ours, theirs);
        }
    }

    #[test]
    fn the_original_row_lists_the_sku_as_an_export_would() {
        let row = original_row(&SnapshotItem {
            seller_key: "s".into(),
            sku: 7,
            product_id: 1,
            product_line_id: 1,
            set_id: 1,
            product_line: "Line".into(),
            set_name: "Set".into(),
            product_name: "Card".into(),
            condition: "Near Mint".into(),
            variant: "Foil".into(),
            quantity: 3,
            current_price: Some(0.1 + 0.2),
            market_price: None,
            pricing_eligible: true,
            pricing_details: None,
            strategy_priced_at: None,
        });
        assert_eq!(row["TCG Marketplace Price"], "0.30000000000000004");
        assert_eq!(row["TCG Market Price"], "");
        assert_eq!(row["Total Quantity"], "3");
        assert_eq!(row.len(), 22);
    }
}
