//! A batch made from a CSV export (`api.inventory-batches-import-csv`): the export read as the
//! Node app reads it (Papa Parse), each row whose SKU the catalog knows in its product line kept
//! (`convertCsvListingsToBatchItems`), saved as a batch with its items (`createImportedBatch`)
//! and queued for pricing in full. The Node app saved the batch and queued it in two transactions;
//! here both are one, so a failed queue leaves no batch behind.
//!
//! Numbers are read as JavaScript reads them.
use std::collections::HashMap;

use chrono::{DurationRound, TimeDelta, Utc};
use serde_json::{Map, Value};

use super::batches::{self, Batch};
use crate::{
    csv_text,
    database::Database,
    features::{
        batch_pricing::{
            imported::{Item, create, refused},
            queue,
        },
        continuous_pricing::scheduler,
        inventory_economics::ledger::fingerprint::js_float,
    },
    js_number,
};

fn field<'a>(row: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    row.get(name).and_then(Value::as_str)
}

/// `parseInteger`: the leading whole number, never under zero; zero when there is none.
fn integer(text: Option<&str>) -> f64 {
    text.filter(|t| !js_number::trim(t).is_empty())
        .and_then(js_number::parse_int)
        .map_or(0.0, |n| if n > 0.0 { n } else { 0.0 })
}

/// `parseNumber`: the leading decimal when finite.
fn decimal(text: Option<&str>) -> Option<f64> {
    text.filter(|t| !js_number::trim(t).is_empty())
        .and_then(js_number::parse_float)
        .filter(|n| n.is_finite())
}

/// A product line's URL name as the Node app guessed it: lower case, each run of space a dash.
fn url_name(name: &str) -> String {
    let mut url = String::new();
    let mut in_space = false;
    for c in name.to_lowercase().chars() {
        if js_number::is_space(c) {
            if !in_space {
                url.push('-');
            }
            in_space = true;
        } else {
            url.push(c);
            in_space = false;
        }
    }
    url
}

/// `convertCsvListingsToBatchItems`: the rows with a positive SKU whose product line and SKU the
/// catalog knows, in the export's order.
pub async fn items(db: &Database, rows: &[Map<String, Value>]) -> Result<Vec<Item>, String> {
    let valid: Vec<(f64, &Map<String, Value>)> = rows
        .iter()
        .filter_map(|row| {
            let sku = field(row, "TCGplayer Id").map_or(f64::NAN, js_number::number);
            (sku.is_finite() && sku > 0.0).then_some((sku, row))
        })
        .collect();
    let mut lines: HashMap<&str, Option<i32>> = HashMap::new();
    for (_, row) in &valid {
        let Some(name) = field(row, "Product Line").map(js_number::trim) else {
            continue;
        };
        if name.is_empty() || lines.contains_key(name) {
            continue;
        }
        let id: Option<i32> = sqlx::query_scalar(
            "SELECT product_line_id FROM product_lines
             WHERE product_line_name = $1 OR product_line_url_name = $2 LIMIT 1",
        )
        .bind(name)
        .bind(url_name(name))
        .fetch_optional(&db.0)
        .await
        .map_err(refused)?;
        lines.insert(name, id);
    }
    let mut items = Vec::new();
    for (sku, row) in valid {
        let name = field(row, "Product Line").map_or("", js_number::trim);
        let Some(Some(line)) = lines.get(name).copied() else {
            continue;
        };
        let found: Option<(i32, i32, i32)> = sqlx::query_as(
            "SELECT product_line_id, set_id, product_id FROM skus
             WHERE sku = $1::text::int AND product_line_id = $2",
        )
        .bind(js_float(sku))
        .bind(line)
        .fetch_optional(&db.0)
        .await
        .map_err(refused)?;
        let Some((product_line_id, set_id, product_id)) = found else {
            continue;
        };
        if product_line_id == 0 || set_id == 0 || product_id == 0 {
            continue;
        }
        items.push(Item {
            sku,
            total_quantity: integer(field(row, "Total Quantity")),
            add_to_quantity: integer(field(row, "Add to Quantity")),
            current_price: decimal(field(row, "TCG Marketplace Price")),
            product_line_id,
            set_id,
            product_id,
            original_row: row.clone(),
        });
    }
    Ok(items)
}

/// The batch made from the export named `file_name`, queued for pricing in full.
pub async fn csv(db: &Database, file_name: &str, bytes: &[u8]) -> Result<Batch, String> {
    let rows = csv_text::parse(&csv_text::decode(bytes));
    let items = items(db, &rows).await?;
    if items.is_empty() {
        return Err(format!(
            "No valid CSV rows were available to import from {file_name}"
        ));
    }
    let config = scheduler::job_config(db).await.map_err(refused)?;
    let now = Utc::now()
        .duration_trunc(TimeDelta::milliseconds(1))
        .unwrap_or_else(|_| Utc::now());
    let mut tx = db.0.begin().await.map_err(refused)?;
    let batch = create(&mut tx, "csv", file_name, &items, now).await?;
    queue::create_or_reuse(&mut tx, batch, "full", &config)
        .await
        .map_err(refused)?;
    tx.commit().await.map_err(refused)?;
    batches::one(db, batch).await
}

#[cfg(test)]
mod tests {
    use chrono::DateTime;

    use super::*;

    #[test]
    fn quantities_and_prices_read_as_node_reads_them() {
        assert_eq!(integer(Some("12abc")), 12.0);
        assert_eq!(integer(Some("-4")), 0.0);
        assert_eq!(integer(Some("-0")), 0.0);
        assert_eq!(integer(Some("  ")), 0.0);
        assert_eq!(integer(None), 0.0);
        assert_eq!(decimal(Some(" 1.5x")), Some(1.5));
        assert_eq!(decimal(Some("Infinity")), None);
        assert_eq!(decimal(Some("")), None);
        assert_eq!(url_name("Magic: The  Gathering"), "magic:-the-gathering");
        assert_eq!(url_name("D & D\u{a0}Miniatures"), "d-&-d-miniatures");
    }

    fn cases() -> (Vec<Value>, Vec<Value>) {
        let read = |path: &str| -> Vec<Value> {
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
        };
        (
            read(".port-logs/csv-import-cases.json"),
            read(".port-logs/csv-import.node.json"),
        )
    }

    /// Every number as a float, so `2` and `2.0` compare equal.
    fn floats(value: Value) -> Value {
        match value {
            Value::Number(n) => serde_json::json!(n.as_f64()),
            Value::Array(items) => Value::Array(items.into_iter().map(floats).collect()),
            Value::Object(fields) => {
                Value::Object(fields.into_iter().map(|(k, v)| (k, floats(v))).collect())
            }
            other => other,
        }
    }

    fn as_node(item: &Item) -> Value {
        serde_json::json!({
            "sku": item.sku,
            "totalQuantity": item.total_quantity,
            "addToQuantity": item.add_to_quantity,
            "currentPrice": item.current_price,
            "productLineId": item.product_line_id,
            "setId": item.set_id,
            "productId": item.product_id,
            "originalRow": item.original_row,
        })
    }

    /// Every case Node read with Papa Parse and `convertCsvListingsToBatchItems` against the dev
    /// catalog (`.port-logs/csv-import-node.ts`): the same rows, and the same items or refusal.
    #[tokio::test]
    #[ignore = "reads the dev catalog, and Node's readings in .port-logs"]
    async fn exports_read_as_node_reads_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let (cases, node) = cases();
        assert_eq!(cases.len(), node.len());
        for (case, theirs) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let rows =
                csv_text::parse(&csv_text::decode(case["text"].as_str().unwrap().as_bytes()));
            let ours: Vec<Value> = rows.iter().cloned().map(Value::Object).collect();
            assert_eq!(Value::Array(ours), theirs["rows"], "{name}: rows");
            match (items(&db, &rows).await, theirs.get("error")) {
                (Ok(items), None) => {
                    let mut expected = theirs["items"].as_array().unwrap().clone();
                    for item in &mut expected {
                        item.as_object_mut().unwrap().remove("marketPrice");
                    }
                    let ours: Vec<Value> = items.iter().map(as_node).collect();
                    assert_eq!(
                        floats(Value::Array(ours)),
                        floats(Value::Array(expected)),
                        "{name}: items"
                    );
                }
                (Err(ours), Some(error)) => assert_eq!(ours, error.as_str().unwrap(), "{name}"),
                (ours, theirs) => panic!("{name}: {ours:?} against {theirs:?}"),
            }
        }
    }

    /// An item as saved: SKU, quantities, price as text, product, row, and when.
    type Saved = (i32, i32, i32, Option<String>, i32, Value, DateTime<Utc>);

    /// An import on the dev database, inside a transaction rolled back: the batch is saved
    /// pending with its items as read, then queued in full; a repeated SKU is refused as Node's
    /// insert refused it.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn an_export_is_saved_and_queued() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let (cases, _) = cases();
        let text = |name: &str| {
            let case = cases.iter().find(|c| c["name"] == name).unwrap();
            csv_text::parse(&csv_text::decode(case["text"].as_str().unwrap().as_bytes()))
        };
        let plain = items(&db, &text("plain")).await.unwrap();
        let now = Utc::now()
            .duration_trunc(TimeDelta::milliseconds(1))
            .unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('inventory_batch_pricing_jobs tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        let batch = create(&mut tx, "csv", "plain.csv", &plain, now)
            .await
            .unwrap();
        let saved: Vec<Saved> = sqlx::query_as(
            "SELECT sku, total_quantity, add_to_quantity, current_price::text, product_id,
                    original_row_json, created_at
             FROM inventory_batch_items WHERE batch_number = $1 ORDER BY sku",
        )
        .bind(batch)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        let expected: Vec<Saved> = plain
            .iter()
            .map(|i| {
                (
                    i.sku as i32,
                    i.total_quantity as i32,
                    i.add_to_quantity as i32,
                    i.current_price.map(|p| format!("{p:.2}")),
                    i.product_id,
                    Value::Object(i.original_row.clone()),
                    now,
                )
            })
            .collect();
        assert_eq!(saved, expected);
        let (status, source, label): (String, String, String) = sqlx::query_as(
            "SELECT status, source_type, source_label FROM inventory_batches WHERE batch_number = $1",
        )
        .bind(batch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            (status.as_str(), source.as_str(), label.as_str()),
            ("pending", "csv", "plain.csv")
        );
        let queued = queue::create_or_reuse(&mut tx, batch, "full", &serde_json::json!({}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(queued.status, "queued");

        let repeated = items(&db, &text("odd-numbers")).await.unwrap();
        sqlx::query("SAVEPOINT repeated")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            create(&mut tx, "csv", "odd.csv", &repeated, now).await,
            Err("error: duplicate key value violates unique constraint \"inventory_batch_items_pkey\"".into())
        );
        tx.rollback().await.unwrap();
    }
}
