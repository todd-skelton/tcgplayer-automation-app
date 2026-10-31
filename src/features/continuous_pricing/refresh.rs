//! Reading the seller's live inventory again from TCGplayer (`refreshContinuousPricingInventory`):
//! every live listing of the seller's from the search API, each regular listing a SKU, the SKUs
//! known to the catalog kept with their market prices, and the snapshot saved over the tracked
//! inventory: what was not seen is out of stock, and prices published since are kept.
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::{
    database::Database,
    features::{
        batch_pricing::job::MarketData,
        configuration::config::{self as pricing_config},
        http_configuration::config::Domain,
        inventory_economics::ledger::fingerprint::js_float,
    },
    tcgplayer::{Call, TcgPlayer},
};

/// Set when pricing had no sales history, market price, or listing to work from.
pub const NO_DATA_PAUSE_REASON: &str =
    "No usable sales history, market price, or listing to price this SKU.";

/// The search API's page, as `getAllProducts` asks for it.
const PAGE_SIZE: usize = 24;
/// Market prices are asked for this many SKUs at a time.
const MARKET_PRICE_BATCH_SIZE: usize = 250;

/// A product the search found, with the seller's listings of it.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Product {
    pub product_line_name: Option<String>,
    pub set_name: Option<String>,
    pub product_name: Option<String>,
    pub market_price: Option<f64>,
    pub listings: Vec<Listing>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Listing {
    pub product_condition_id: f64,
    pub printing: Option<String>,
    pub condition: Option<String>,
    pub quantity: f64,
    pub price: f64,
    pub custom_data: Option<Value>,
}

impl Listing {
    /// A custom listing has a price set by hand, which pricing leaves alone.
    fn is_custom(&self) -> bool {
        self.custom_data
            .as_ref()
            .and_then(|d| d.get("customListingId"))
            .is_some_and(|id| match id {
                Value::Null => false,
                Value::Bool(b) => *b,
                Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
                Value::String(s) => !s.is_empty(),
                _ => true,
            })
    }
}

/// Where the seller's live listings are read.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait SellerInventory {
    async fn products(&self, seller: &str) -> Result<Vec<Product>, String>;
}

#[derive(Deserialize)]
struct SearchAnswer {
    results: Vec<SearchPage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchPage {
    results: Vec<Product>,
    total_results: usize,
}

/// The search API, through the app's TCGplayer client.
#[derive(Clone)]
pub struct TcgPlayerSearch(pub TcgPlayer);

impl SellerInventory for TcgPlayerSearch {
    async fn products(&self, seller: &str) -> Result<Vec<Product>, String> {
        let mut products = Vec::new();
        let mut total = 0;
        loop {
            let body = json!({
                "size": PAGE_SIZE,
                "from": products.len(),
                "listingSearch": {
                    "context": { "cart": {} },
                    "filters": {
                        "term": { "sellerStatus": "Live", "channelId": 0, "sellerKey": [seller] },
                        "range": { "quantity": { "gte": 1 } },
                        "exclude": { "channelExclusion": 0 },
                    },
                },
            });
            let answer: SearchAnswer = self
                .0
                .post(
                    Domain::MpSearchApi,
                    "/v1/search/request",
                    &body,
                    Call::default(),
                )
                .await
                .map_err(|e| e.to_string())?;
            let page = answer
                .results
                .into_iter()
                .next()
                .ok_or("The search answered without results.")?;
            if products.is_empty() {
                total = page.total_results;
            }
            if page.results.is_empty() {
                break;
            }
            products.extend(page.results);
            if products.len() >= total {
                break;
            }
        }
        Ok(products)
    }
}

/// A SKU of the seller's listings, as a CSV row would list it (`convertProductToListing`).
#[derive(Clone, Debug, PartialEq)]
struct Row {
    sku: f64,
    product_line: String,
    set_name: String,
    product: String,
    variant: String,
    condition: String,
    total_quantity: String,
    marketplace_price: String,
}

/// Each regular listing once, first seen first (`convertSellerInventoryToListings`).
fn rows(products: &[Product]) -> Vec<Row> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for product in products {
        for listing in product.listings.iter().filter(|l| !l.is_custom()) {
            let id = js_float(listing.product_condition_id);
            if !seen.insert(id) {
                eprintln!(
                    "Duplicate SKU ID found: {}. Skipping duplicate listing.",
                    js_float(listing.product_condition_id)
                );
                continue;
            }
            rows.push(Row {
                sku: listing.product_condition_id,
                product_line: product.product_line_name.clone().unwrap_or_default(),
                set_name: product.set_name.clone().unwrap_or_default(),
                product: product.product_name.clone().unwrap_or_default(),
                variant: listing.printing.clone().unwrap_or_default(),
                condition: listing.condition.clone().unwrap_or_default(),
                total_quantity: js_float(listing.quantity),
                marketplace_price: js_float(listing.price),
            });
        }
    }
    rows
}

/// `Number.parseInt` of a quantity, never under zero.
fn whole(text: &str) -> i32 {
    let digits: String = text
        .trim_start()
        .char_indices()
        .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+')))
        .map(|(_, c)| c)
        .collect();
    digits
        .parse::<i64>()
        .map_or(0, |n| n.clamp(0, i64::from(i32::MAX)) as i32)
}

/// A SKU of the snapshot, as the tracked inventory saves it.
#[derive(Clone, Debug, PartialEq)]
pub struct Observed {
    pub sku: i32,
    pub product_id: i32,
    pub product_line_id: i32,
    pub set_id: i32,
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub variant: String,
    pub quantity: i32,
    pub current_price: Option<f64>,
}

/// The rows whose SKUs the catalog knows in their product line
/// (`convertCsvListingsToBatchItems`).
async fn known(db: &Database, rows: Vec<Row>) -> sqlx::Result<Vec<Observed>> {
    let valid: Vec<Row> = rows
        .into_iter()
        .filter(|r| r.sku.is_finite() && r.sku > 0.0)
        .collect();
    let mut lines: HashMap<String, Option<i32>> = HashMap::new();
    for row in &valid {
        let name = row.product_line.trim();
        if name.is_empty() || lines.contains_key(name) {
            continue;
        }
        let url_name = name
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-");
        let id: Option<i32> = sqlx::query_scalar(
            "SELECT product_line_id FROM product_lines
             WHERE product_line_name = $1 OR product_line_url_name = $2 LIMIT 1",
        )
        .bind(name)
        .bind(url_name)
        .fetch_optional(&db.0)
        .await?;
        lines.insert(name.to_owned(), id);
    }
    let mut observed = Vec::new();
    for row in valid {
        let Some(Some(line)) = lines.get(row.product_line.trim()).copied() else {
            continue;
        };
        if row.sku.fract() != 0.0 || row.sku > f64::from(i32::MAX) {
            continue;
        }
        let sku = row.sku as i32;
        let found: Option<(Option<i32>, Option<i32>, Option<i32>)> = sqlx::query_as(
            "SELECT product_line_id, set_id, product_id FROM skus
             WHERE sku = $1 AND product_line_id = $2",
        )
        .bind(sku)
        .bind(line)
        .fetch_optional(&db.0)
        .await?;
        let Some((Some(product_line_id), Some(set_id), Some(product_id))) = found else {
            continue;
        };
        if product_line_id == 0 || set_id == 0 || product_id == 0 {
            continue;
        }
        let price = row
            .marketplace_price
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|p| p.is_finite());
        observed.push(Observed {
            sku,
            product_id,
            product_line_id,
            set_id,
            product_line: row.product_line,
            set_name: row.set_name,
            product_name: row.product,
            condition: row.condition,
            variant: row.variant,
            quantity: whole(&row.total_quantity),
            current_price: price,
        });
    }
    Ok(observed)
}

/// The SKUs' positive market prices, asked for a batch at a time (`fetchMarketPricesBySku`).
pub async fn market_prices(
    market: &impl MarketData,
    skus: &[i64],
) -> Result<HashMap<i64, f64>, String> {
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for sku in skus {
        if seen.insert(*sku) {
            unique.push(*sku);
        }
    }
    let mut prices = HashMap::new();
    for chunk in unique.chunks(MARKET_PRICE_BATCH_SIZE) {
        for (sku, point) in market.price_points(chunk).await? {
            if point.market_price.is_finite() && point.market_price > 0.0 {
                prices.insert(sku, point.market_price);
            }
        }
    }
    Ok(prices)
}

/// Saves the snapshot (`upsertSnapshot`) in `conn`'s transaction: a refresh recorded, each SKU
/// seen saved over its tracked row, the rest out of stock, publications made since reconciled.
pub async fn save_snapshot(
    conn: &mut PgConnection,
    seller: &str,
    items: &[(Observed, Option<f64>, bool)],
    observed_at: DateTime<Utc>,
    minimum_interval_minutes: i64,
) -> sqlx::Result<()> {
    let refresh: i64 = sqlx::query_scalar(
        "INSERT INTO continuous_pricing_refreshes (seller_key, status, observed_count)
         VALUES ($1, 'refreshing', $2) RETURNING id",
    )
    .bind(seller)
    .bind(items.len() as i32)
    .fetch_one(&mut *conn)
    .await?;
    if !items.is_empty() {
        let ints =
            |f: fn(&Observed) -> i32| items.iter().map(|(o, _, _)| f(o)).collect::<Vec<i32>>();
        let texts = |f: fn(&Observed) -> &str| {
            items
                .iter()
                .map(|(o, _, _)| f(o).to_owned())
                .collect::<Vec<String>>()
        };
        sqlx::query(
            "INSERT INTO continuous_pricing_inventory (
               seller_key, sku, product_id, product_line_id, set_id, product_line, set_name,
               product_name, condition, variant, quantity, current_price, market_price, in_stock,
               pricing_eligible, last_observed_at)
             SELECT $1, i.sku, i.product_id, i.product_line_id, i.set_id, i.product_line, i.set_name,
               i.product_name, i.condition, i.variant, i.quantity, i.current_price, i.market_price,
               i.quantity > 0, i.eligible, $15
             FROM UNNEST($2::int[], $3::int[], $4::int[], $5::int[], $6::text[], $7::text[],
                         $8::text[], $9::text[], $10::text[], $11::int[], $12::float8[],
                         $13::float8[], $14::bool[])
               AS i(sku, product_id, product_line_id, set_id, product_line, set_name, product_name,
                    condition, variant, quantity, current_price, market_price, eligible)
             ON CONFLICT (seller_key, sku) DO UPDATE SET
               product_id = EXCLUDED.product_id,
               product_line_id = EXCLUDED.product_line_id,
               set_id = EXCLUDED.set_id,
               product_line = EXCLUDED.product_line,
               set_name = EXCLUDED.set_name,
               product_name = EXCLUDED.product_name,
               condition = EXCLUDED.condition,
               variant = EXCLUDED.variant,
               quantity = EXCLUDED.quantity,
               current_price = CASE
                 WHEN continuous_pricing_inventory.last_published_at IS NULL
                   OR continuous_pricing_inventory.last_published_at <= EXCLUDED.last_observed_at
                 THEN EXCLUDED.current_price
                 ELSE continuous_pricing_inventory.current_price
               END,
               market_price = EXCLUDED.market_price,
               pause_reason = CASE
                 WHEN continuous_pricing_inventory.pause_reason = $16
                   AND EXCLUDED.market_price IS NOT NULL
                 THEN NULL
                 ELSE continuous_pricing_inventory.pause_reason
               END,
               in_stock = EXCLUDED.in_stock,
               pricing_eligible = EXCLUDED.pricing_eligible,
               last_observed_at = EXCLUDED.last_observed_at,
               updated_at = NOW()",
        )
        .bind(seller)
        .bind(ints(|o| o.sku))
        .bind(ints(|o| o.product_id))
        .bind(ints(|o| o.product_line_id))
        .bind(ints(|o| o.set_id))
        .bind(texts(|o| &o.product_line))
        .bind(texts(|o| &o.set_name))
        .bind(texts(|o| &o.product_name))
        .bind(texts(|o| &o.condition))
        .bind(texts(|o| &o.variant))
        .bind(ints(|o| o.quantity))
        .bind(items.iter().map(|(o, _, _)| o.current_price).collect::<Vec<_>>())
        .bind(items.iter().map(|(_, m, _)| *m).collect::<Vec<_>>())
        .bind(items.iter().map(|(_, _, e)| *e).collect::<Vec<_>>())
        .bind(observed_at)
        .bind(NO_DATA_PAUSE_REASON)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "UPDATE continuous_pricing_inventory SET in_stock = FALSE, quantity = 0, updated_at = NOW()
         WHERE seller_key = $1 AND last_observed_at < $2",
    )
    .bind(seller)
    .bind(observed_at)
    .execute(&mut *conn)
    .await?;
    reconcile_publications(conn, seller, minimum_interval_minutes).await?;
    sqlx::query(
        "UPDATE continuous_pricing_refreshes SET status = 'completed', completed_at = NOW()
         WHERE id = $1",
    )
    .bind(refresh)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Takes in each SKU's latest publication made from new inventory
/// (`reconcileInventoryManagementPublications`): its price and when, and its next pricing no
/// sooner than an interval after; how many.
async fn reconcile_publications(
    conn: &mut PgConnection,
    seller: &str,
    minimum_interval_minutes: i64,
) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "WITH latest_publication AS (
           SELECT DISTINCT ON (item.sku) item.sku, item.desired_price, item.priced_at, item.published_at
           FROM inventory_publication_items item
           JOIN inventory_publications publication ON publication.id = item.publication_id
           WHERE publication.source_type = 'pending_inventory'
             AND publication.seller_key = $1
             AND item.status = 'published'
             AND item.published_at IS NOT NULL
           ORDER BY item.sku, item.published_at DESC, item.id DESC
         )
         UPDATE continuous_pricing_inventory inventory
         SET last_priced_at = GREATEST(COALESCE(inventory.last_priced_at, latest.priced_at), latest.priced_at),
             last_published_price = latest.desired_price,
             last_published_at = latest.published_at,
             next_price_at = GREATEST(inventory.next_price_at, latest.published_at + ($2 * INTERVAL '1 minute')),
             updated_at = NOW()
         FROM latest_publication latest
         WHERE inventory.seller_key = $1
           AND inventory.sku = latest.sku
           AND (inventory.last_published_at IS NULL OR inventory.last_published_at < latest.published_at)",
    )
    .bind(seller)
    .bind(minimum_interval_minutes as f64)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// What a refresh read, ready to save: each SKU with its market price and whether its product line
/// is priced.
pub async fn read(
    db: &Database,
    seller: &str,
    inventory: &impl SellerInventory,
    market: &impl MarketData,
) -> Result<(Vec<(Observed, Option<f64>, bool)>, DateTime<Utc>), String> {
    let config = pricing_config::load(db).await.map_err(|e| e.to_string())?;
    let skipped: HashSet<i32> = config
        .product_lines
        .settings
        .iter()
        .filter(|(_, s)| s.skip)
        .map(|(id, _)| *id)
        .collect();
    let products = inventory.products(seller).await?;
    let observed_at =
        DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).expect("now is in range");
    let observed = known(db, rows(&products))
        .await
        .map_err(|e| e.to_string())?;
    let skus: Vec<i64> = observed.iter().map(|o| i64::from(o.sku)).collect();
    let prices = market_prices(market, &skus).await?;
    Ok((
        observed
            .into_iter()
            .map(|o| {
                let price = prices.get(&i64::from(o.sku)).copied();
                let eligible = !skipped.contains(&o.product_line_id);
                (o, price, eligible)
            })
            .collect(),
        observed_at,
    ))
}

/// Reads the seller's inventory again and saves it; how many SKUs it saw.
pub async fn refresh(
    db: &Database,
    seller: &str,
    minimum_interval_minutes: i64,
    inventory: &impl SellerInventory,
    market: &impl MarketData,
) -> Result<usize, String> {
    let (items, observed_at) = read(db, seller, inventory, market).await?;
    let failed = |e: sqlx::Error| e.to_string();
    let mut tx = db.0.begin().await.map_err(failed)?;
    save_snapshot(
        &mut tx,
        seller,
        &items,
        observed_at,
        minimum_interval_minutes,
    )
    .await
    .map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    Ok(items.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::batch_pricing::job::PricePoint;

    #[test]
    fn quantities_read_as_parse_int_reads_them() {
        assert_eq!(whole("12"), 12);
        assert_eq!(whole(" 7.9"), 7);
        assert_eq!(whole("-3"), 0);
        assert_eq!(whole("x"), 0);
    }

    #[test]
    fn custom_and_repeated_listings_are_left_out() {
        let listing = |sku: f64, custom: Value| Listing {
            product_condition_id: sku,
            quantity: 2.0,
            price: 1.5,
            custom_data: Some(custom),
            ..Listing::default()
        };
        let products = vec![Product {
            product_line_name: Some("Pokemon".into()),
            market_price: Some(0.0),
            listings: vec![
                listing(1.0, json!({ "images": [] })),
                listing(2.0, json!({ "customListingId": 9 })),
                listing(1.0, json!({})),
                listing(3.0, json!({ "customListingId": 0 })),
            ],
            ..Product::default()
        }];
        let rows = rows(&products);
        assert_eq!(rows.iter().map(|r| r.sku).collect::<Vec<_>>(), [1.0, 3.0]);
        assert_eq!(
            (
                rows[0].total_quantity.as_str(),
                rows[0].marketplace_price.as_str()
            ),
            ("2", "1.5")
        );
    }

    struct Fixture(Vec<Product>);

    impl SellerInventory for Fixture {
        async fn products(&self, _: &str) -> Result<Vec<Product>, String> {
            Ok(self.0.clone())
        }
    }

    /// The price points `.port-logs/refresh-node.ts` answers Node with.
    struct Points;

    impl MarketData for Points {
        async fn price_points(&self, skus: &[i64]) -> Result<HashMap<i64, PricePoint>, String> {
            Ok(skus
                .iter()
                .filter(|s| *s % 13 != 0)
                .map(|s| {
                    let market_price = if s % 3 == 0 {
                        0.0
                    } else {
                        (s % 97) as f64 / 10.0 + 0.01
                    };
                    (
                        *s,
                        PricePoint {
                            market_price,
                            ..PricePoint::default()
                        },
                    )
                })
                .collect())
        }
    }

    /// Node's refresh on dev against a fixture of search results and price points
    /// (`.port-logs/refresh-node.ts`), its transaction read and rolled back; then this refresh of
    /// the same fixture: every tracked SKU it touched, and the refresh it recorded, match.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's run in .port-logs"]
    async fn a_refresh_saves_what_node_s_saves() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_file = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let fixture: Value = serde_json::from_str(&read_file("refresh-fixture.json")).unwrap();
        let products: Vec<Product> = serde_json::from_value(fixture["products"].clone()).unwrap();
        let node: Value = serde_json::from_str(&read_file("refresh.node.json")).unwrap();
        let settings = super::super::store::settings(&db).await.unwrap();
        let (items, observed_at) = read(&db, &settings.seller_key, &Fixture(products), &Points)
            .await
            .unwrap();
        let mut tx = db.0.begin().await.unwrap();
        save_snapshot(
            &mut tx,
            &settings.seller_key,
            &items,
            observed_at,
            settings.minimum_interval_minutes,
        )
        .await
        .unwrap();
        let ours: Value = sqlx::query_scalar(&read_file("refresh-capture.sql"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        let theirs = &node["captured"];
        println!(
            "{} SKUs read here, {} by Node; {} rows touched here, {} by Node",
            items.len(),
            node["count"],
            ours["inventory"].as_array().unwrap().len(),
            theirs["inventory"].as_array().unwrap().len()
        );
        let mut differences = Vec::new();
        for (x, y) in ours["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .zip(theirs["inventory"].as_array().unwrap())
        {
            if x != y {
                differences.push(format!("{x}\n  vs {y}"));
            }
        }
        for d in differences.iter().take(5) {
            println!("{d}");
        }
        assert_eq!(items.len() as u64, node["count"].as_u64().unwrap());
        assert_eq!(ours["refreshes"], theirs["refreshes"]);
        assert_eq!(
            ours["inventory"].as_array().unwrap().len(),
            theirs["inventory"].as_array().unwrap().len()
        );
        assert!(differences.is_empty());
    }
}
