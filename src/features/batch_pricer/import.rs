//! A batch made from a CSV export (`api.inventory-batches-import-csv`): the export read as Papa
//! Parse reads it, each row whose SKU the catalog knows in its product line kept
//! (`convertCsvListingsToBatchItems`), saved as a batch with its items (`createImportedBatch`)
//! and queued for pricing in full, both in one transaction, so a failed queue leaves no batch
//! behind.
//!
//! A batch made from a seller's live inventory (`api.inventory-batches-import-seller`) is the
//! same: the seller's listings read from TCGplayer's search (`fetchSellerInventorySnapshot`),
//! skipped product lines left out, each regular listing made the row a CSV export would have
//! (`convertSellerInventoryToListings`), then kept and saved as a CSV's rows are.
//!
//! Numbers are read as JavaScript reads them.
use std::collections::HashMap;

use chrono::{DurationRound, TimeDelta, Utc};
use serde_json::{Map, Value};
use sqlx::PgConnection;

use crate::{
    csv_text,
    database::Database,
    features::{
        batch_pricing::{
            imported::{Item, create, refused},
            queue,
        },
        continuous_pricing::{
            refresh::{Product, SellerInventory},
            scheduler,
        },
        inventory_economics::ledger::fingerprint::js_float,
        inventory_strategy::collate,
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

/// A product line's URL name, guessed from its name: lower case, each run of space a dash.
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
pub async fn items(
    conn: &mut PgConnection,
    rows: &[Map<String, Value>],
) -> Result<Vec<Item>, String> {
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
        .fetch_optional(&mut *conn)
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
        .fetch_optional(&mut *conn)
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

/// The largest CSV export the screen takes.
pub const MOST_EXPORT_BYTES: usize = 20 << 20;

/// Why no batch was made: nothing in the import could be kept (the person's to fix), or anything
/// else failing.
#[derive(Debug, PartialEq)]
pub enum NotImported {
    Nothing(String),
    Failed(String),
}

impl std::fmt::Display for NotImported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotImported::Nothing(why) | NotImported::Failed(why) => f.write_str(why),
        }
    }
}

impl From<String> for NotImported {
    fn from(why: String) -> Self {
        NotImported::Failed(why)
    }
}

/// The batch made from the export named `file_name`, queued for pricing in full; its number.
pub async fn csv(db: &Database, file_name: &str, bytes: &[u8]) -> Result<i32, NotImported> {
    let mut tx = db.0.begin().await.map_err(refused)?;
    let batch = save_csv(&mut tx, file_name, bytes).await?;
    tx.commit().await.map_err(refused)?;
    Ok(batch)
}

/// Saves the batch the export named `file_name` makes on `conn`, queued for pricing in full;
/// its number.
pub async fn save_csv(
    conn: &mut PgConnection,
    file_name: &str,
    bytes: &[u8],
) -> Result<i32, NotImported> {
    let rows = csv_text::parse(&csv_text::decode(bytes));
    let items = items(conn, &rows).await?;
    if items.is_empty() {
        return Err(NotImported::Nothing(format!(
            "No valid CSV rows were available to import from {file_name}"
        )));
    }
    let config = scheduler::job_config_on(&mut *conn)
        .await
        .map_err(refused)?;
    let now = Utc::now()
        .duration_trunc(TimeDelta::milliseconds(1))
        .unwrap_or_else(|_| Utc::now());
    let batch = create(conn, "csv", file_name, &items, now).await?;
    queue::create_or_reuse(conn, batch, "full", &config)
        .await
        .map_err(refused)?;
    Ok(batch)
}

/// The product lines the pricing configuration skips.
fn skipped_lines(config: &Value) -> Vec<f64> {
    config["productLinePricing"]["productLineSettings"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, setting)| setting["skip"].as_bool() == Some(true))
        .map(|(id, _)| js_number::number(id))
        .collect()
}

/// The seller's products as `fetchSellerInventorySnapshot` keeps them: skipped product lines
/// left out, sorted by product line, set and name.
fn snapshot(mut products: Vec<Product>, skipped: &[f64]) -> Vec<Product> {
    products.retain(|p| {
        !p.product_line_id
            .is_some_and(|line| skipped.contains(&line))
    });
    let text = |t: &Option<String>| t.clone().unwrap_or_default();
    products.sort_by(|a, b| {
        collate::compare(&text(&a.product_line_name), &text(&b.product_line_name))
            .then_with(|| collate::compare(&text(&a.set_name), &text(&b.set_name)))
            .then_with(|| collate::compare(&text(&a.product_name), &text(&b.product_name)))
    });
    products
}

/// Each regular listing once, first seen first, as the row `convertProductToListing` makes: a
/// field the search left out is left out of the row, as `JSON.stringify` leaves it.
pub fn listing_rows(products: &[Product]) -> Vec<Map<String, Value>> {
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for product in products {
        for listing in product.listings.iter().filter(|l| !l.is_custom()) {
            let id = js_float(listing.product_condition_id);
            if !seen.insert(id.clone()) {
                tracing::warn!("Duplicate SKU ID found: {id}. Skipping duplicate listing.");
                continue;
            }
            let market = product
                .market_price
                .filter(|price| *price > 0.0)
                .map_or_else(String::new, js_float);
            let mut row = Map::new();
            let mut put = |name: &str, value: Option<String>| {
                if let Some(value) = value {
                    row.insert(name.into(), Value::String(value));
                }
            };
            let empty = || Some(String::new());
            put("TCGplayer Id", Some(id));
            put("Product Line", product.product_line_name.clone());
            put("Set Name", product.set_name.clone());
            put("Product", product.product_name.clone());
            put(
                "Sku Variant",
                Some(listing.printing.clone().unwrap_or_default()),
            );
            put("Sku Condition", listing.condition.clone());
            put("Sale Count", empty());
            put("Lowest Sale Price", empty());
            put("Highest Sale Price", empty());
            put("TCG Market Price", Some(market));
            put("Total Quantity", Some(js_float(listing.quantity)));
            put("Add to Quantity", Some("0".into()));
            put("TCG Marketplace Price", Some(js_float(listing.price)));
            for name in [
                "Previous Price",
                "Suggested Price",
                "Percentile Used",
                "Historical Sales Velocity (Days)",
                "Estimated Time to Sell (Days)",
                "Sales Count for Historical Calculation",
                "Listings Count for Estimated Calculation",
                "Warning",
                "Error",
            ] {
                put(name, empty());
            }
            rows.push(row);
        }
    }
    rows
}

/// The seller whose live inventory made the newest batch, if one did: what the New Batch form
/// starts from, the last seller key sent.
pub async fn last_seller(conn: impl sqlx::PgExecutor<'_>) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(
        "SELECT source_label FROM inventory_batches WHERE source_type = 'seller'
         ORDER BY batch_number DESC LIMIT 1",
    )
    .fetch_optional(conn)
    .await
}

/// The batch frozen from `seller`'s live inventory, queued for pricing in full; its number.
pub async fn seller(
    db: &Database,
    inventory: &impl SellerInventory,
    seller: &str,
) -> Result<i32, NotImported> {
    let products = inventory.products(seller).await?;
    let mut tx = db.0.begin().await.map_err(refused)?;
    let batch = save_seller(&mut tx, products, seller).await?;
    tx.commit().await.map_err(refused)?;
    Ok(batch)
}

/// Saves the batch `products` make for `seller` on `conn`, queued for pricing in full; its
/// number.
pub async fn save_seller(
    conn: &mut PgConnection,
    products: Vec<Product>,
    seller: &str,
) -> Result<i32, NotImported> {
    let config = scheduler::job_config_on(&mut *conn)
        .await
        .map_err(refused)?;
    let rows = listing_rows(&snapshot(products, &skipped_lines(&config)));
    let items = items(conn, &rows).await?;
    if items.is_empty() {
        return Err(NotImported::Nothing(format!(
            "No seller inventory rows were available to import for {seller}"
        )));
    }
    let now = Utc::now()
        .duration_trunc(TimeDelta::milliseconds(1))
        .unwrap_or_else(|_| Utc::now());
    let batch = create(conn, "seller", seller, &items, now).await?;
    queue::create_or_reuse(conn, batch, "full", &config)
        .await
        .map_err(refused)?;
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use chrono::DateTime;

    use super::*;

    /// The New Batch form starts from the seller of the newest seller batch, whatever batches
    /// were made after it from a CSV.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction it rolls back"]
    async fn the_last_seller_is_the_newest_seller_batch() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::query("DELETE FROM inventory_batches WHERE source_type = 'seller'")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(last_seller(&mut *tx).await.unwrap(), None);
        for (source, label) in [("seller", "first"), ("seller", "second"), ("csv", "a.csv")] {
            create(&mut tx, source, label, &[], Utc::now())
                .await
                .unwrap();
        }
        assert_eq!(
            last_seller(&mut *tx).await.unwrap().as_deref(),
            Some("second")
        );
        tx.rollback().await.unwrap();
    }

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

    /// A seller export: two SKUs the dev catalog knows, one it does not, and one row without a SKU.
    const PLAIN: &str =
        "TCGplayer Id,Product Line,Total Quantity,Add to Quantity,TCG Marketplace Price
2231,Magic: The Gathering,3,1,0.25
2233,Magic: The Gathering,0,2,
999999999,Magic: The Gathering,1,0,1.00
,Magic: The Gathering,1,0,1.00
";

    /// An export naming one SKU twice.
    const REPEATED: &str =
        "TCGplayer Id,Product Line,Total Quantity,Add to Quantity,TCG Marketplace Price
2231,Magic: The Gathering,1,0,0.25
2231,Magic: The Gathering,2,0,0.30
";

    /// An item as saved: SKU, quantities, price as text, product, row, and when.
    type Saved = (i32, i32, i32, Option<String>, i32, Value, DateTime<Utc>);

    /// An import on the dev database, inside a transaction rolled back: the batch is saved
    /// pending with its items as read, then queued in full; a repeated SKU is refused by the
    /// items' primary key.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn an_export_is_saved_and_queued() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let text = |csv: &str| csv_text::parse(&csv_text::decode(csv.as_bytes()));
        let mut conn = db.0.acquire().await.unwrap();
        let plain = items(&mut conn, &text(PLAIN)).await.unwrap();
        assert_eq!(
            plain.iter().map(|i| i.sku).collect::<Vec<_>>(),
            [2231.0, 2233.0]
        );
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

        let repeated = items(&mut conn, &text(REPEATED)).await.unwrap();
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
