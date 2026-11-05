//! A batch saved with its items (`createImportedBatch`), as a CSV export or the strategy's
//! snapshot makes one. Numbers go to the database as the text node-postgres sends, so a SKU or
//! quantity the database refuses is refused with the same message.
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use sqlx::{PgConnection, types::Json};

use crate::features::inventory_economics::ledger::fingerprint::js_float;

/// An item of the batch.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// As JavaScript holds it: a whole number the database may still refuse.
    pub sku: f64,
    pub total_quantity: f64,
    pub add_to_quantity: f64,
    pub current_price: Option<f64>,
    pub product_line_id: i32,
    pub set_id: i32,
    pub product_id: i32,
    pub original_row: Map<String, Value>,
}

/// A database refusal as the Node app reported it (`String(error)`).
pub fn refused(e: sqlx::Error) -> String {
    match e.as_database_error() {
        Some(db) => format!("error: {}", db.message()),
        None => e.to_string(),
    }
}

/// `createImportedBatch`: a pending batch from `source_type` named `label`, with the items;
/// its number.
pub async fn create(
    conn: &mut PgConnection,
    source_type: &str,
    label: &str,
    items: &[Item],
    now: DateTime<Utc>,
) -> Result<i32, String> {
    let batch: i32 = sqlx::query_scalar(
        "INSERT INTO inventory_batches (status, source_type, source_label)
         VALUES ('pending', $1, $2) RETURNING batch_number",
    )
    .bind(source_type)
    .bind(label)
    .fetch_one(&mut *conn)
    .await
    .map_err(refused)?;
    let text = |f: fn(&Item) -> f64| items.iter().map(|i| js_float(f(i))).collect::<Vec<_>>();
    let id = |f: fn(&Item) -> i32| items.iter().map(f).collect::<Vec<_>>();
    sqlx::query(
        "INSERT INTO inventory_batch_items (
           batch_number, sku, total_quantity, add_to_quantity, current_price,
           product_line_id, set_id, product_id, original_row_json, created_at, updated_at)
         SELECT $1, item.sku::int, item.total::int, item.added::int, item.price::numeric,
           item.line, item.set, item.product, item.row, $9, $9
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[],
                     $8::int[], $10::jsonb[])
           AS item(sku, total, added, price, line, set, product, row)",
    )
    .bind(batch)
    .bind(text(|i| i.sku))
    .bind(text(|i| i.total_quantity))
    .bind(text(|i| i.add_to_quantity))
    .bind(
        items
            .iter()
            .map(|i| i.current_price.map(js_float))
            .collect::<Vec<_>>(),
    )
    .bind(id(|i| i.product_line_id))
    .bind(id(|i| i.set_id))
    .bind(id(|i| i.product_id))
    .bind(now)
    .bind(
        items
            .iter()
            .map(|i| Json(&i.original_row))
            .collect::<Vec<_>>(),
    )
    .execute(&mut *conn)
    .await
    .map_err(refused)?;
    Ok(batch)
}
