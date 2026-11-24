//! The SKUs a batch's pricing left for manual review (one with no sales, market price or listing
//! to price from, or one whose pricing reported an error) and what the operator decides for each:
//! a price entered by hand, or the SKU taken out of the batch ([`removal`]).
//!
//! An entered price makes the result successful at that price, so the batch can publish it and
//! stops counting it for review; what pricing said is kept with it, under `manualPrice`. Pricing
//! the whole batch again replaces it, as it replaces every result.
pub mod removal;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::save;
use crate::features::{
    inventory_economics::ledger::{assumptions::js_to_fixed, proceeds::iso},
    inventory_publication::preview,
};

/// The basis a manually entered price's decision names: never `modeled`, so forecast calibration
/// and saved pricing curves leave it out.
pub const BASIS: &str = "manual";

/// The most rows needing review the batch's panel lists; the rest are in its download.
pub const MOST_LISTED: i64 = 50;

/// A SKU's price as the operator entered it.
#[derive(Clone, Debug, PartialEq)]
pub struct ManualPrice {
    pub sku: i32,
    pub price_cents: i64,
    /// Where the price came from, or empty.
    pub note: String,
}

impl ManualPrice {
    fn dollars(&self) -> f64 {
        self.price_cents as f64 / 100.0
    }
}

/// A result left for manual review, as its row names it.
#[derive(Clone, Debug, PartialEq)]
pub struct NeedsReview {
    pub sku: i32,
    pub product_line: String,
    pub set_name: String,
    pub product: String,
    pub condition: String,
    /// The quantity the batch holds and adds.
    pub quantity: i32,
    pub market_price: Option<f64>,
    pub lowest_sale_price: Option<f64>,
    pub highest_sale_price: Option<f64>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(sqlx::FromRow)]
struct ReviewRow {
    sku: i32,
    row_json: Value,
    pricing_details_json: Option<Value>,
    quantity: i32,
    error_messages: Vec<String>,
    warning_messages: Vec<String>,
}

impl ReviewRow {
    fn needs_review(self) -> NeedsReview {
        let text = |column: &str| {
            self.row_json[column]
                .as_str()
                .map_or_else(String::new, |t| t.trim().to_owned())
        };
        let price = |key: &str| {
            self.pricing_details_json
                .as_ref()
                .and_then(|d| d[key].as_f64())
                .filter(|p| *p > 0.0)
        };
        NeedsReview {
            sku: self.sku,
            product_line: text("Product Line"),
            set_name: text("Set Name"),
            product: text("Product"),
            condition: preview::condition(&self.row_json),
            quantity: self.quantity,
            market_price: price("tcgMarketPrice"),
            lowest_sale_price: price("lowestSalePrice"),
            highest_sale_price: price("highestSalePrice"),
            errors: self.error_messages,
            warnings: self.warning_messages,
        }
    }
}

/// A batch's results left for manual review: the first [`MOST_LISTED`], and how many in all.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Review {
    pub listed: Vec<NeedsReview>,
    pub total: i64,
}

/// The batch's results left for manual review, listed by product line, set, product and SKU.
pub async fn needing_review(conn: &mut PgConnection, batch: i32) -> sqlx::Result<Review> {
    let rows: Vec<ReviewRow> = sqlx::query_as(
        "SELECT r.sku, r.row_json, r.pricing_details_json,
           (COALESCE(i.total_quantity, 0) + COALESCE(i.add_to_quantity, 0))::int AS quantity,
           r.error_messages, r.warning_messages
         FROM inventory_batch_results r
         LEFT JOIN inventory_batch_items i ON i.batch_number = r.batch_number AND i.sku = r.sku
         WHERE r.batch_number = $1 AND r.result_status <> 'successful'
         ORDER BY COALESCE(r.row_json->>'Product Line', ''), COALESCE(r.row_json->>'Set Name', ''),
           COALESCE(r.row_json->>'Product', ''), r.sku
         LIMIT $2",
    )
    .bind(batch)
    .bind(MOST_LISTED)
    .fetch_all(&mut *conn)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM inventory_batch_results
         WHERE batch_number = $1 AND result_status <> 'successful'",
    )
    .bind(batch)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Review {
        listed: rows.into_iter().map(ReviewRow::needs_review).collect(),
        total,
    })
}

/// Why a price was not entered.
#[derive(Debug)]
pub enum NotEntered {
    /// The batch is queued or pricing, which would replace the price.
    Pricing,
    /// The SKU's result is gone, or no longer needs review.
    NotForReview,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for NotEntered {
    fn from(e: sqlx::Error) -> Self {
        NotEntered::Database(e)
    }
}

impl NotEntered {
    pub fn message(&self, batch: i32, sku: i32) -> String {
        match self {
            NotEntered::Pricing => {
                format!("Batch {batch} is pricing. Enter the price once its pricing ends.")
            }
            NotEntered::NotForReview => {
                format!("SKU {sku} in batch {batch} no longer needs review.")
            }
            NotEntered::Database(e) => e.to_string(),
        }
    }
}

/// The result's row and pricing details at the entered price, `now`: listed at that price with no
/// error or warning, its decision manual, and what pricing said kept under `manualPrice`.
pub fn entered(
    row: &Value,
    details: Option<&Value>,
    errors: &[String],
    warnings: &[String],
    price: &ManualPrice,
    now: DateTime<Utc>,
) -> (Value, Value) {
    let dollars = price.dollars();
    let mut row = row.clone();
    if let Some(columns) = row.as_object_mut() {
        columns.insert(
            "TCG Marketplace Price".into(),
            js_to_fixed(dollars, 2).into(),
        );
        columns.insert("Error".into(), "".into());
        columns.insert("Warning".into(), "".into());
    }
    let mut details = match details {
        Some(Value::Object(details)) => details.clone(),
        _ => serde_json::Map::new(),
    };
    details.insert("marketplacePrice".into(), json!(dollars));
    details.insert("pricedAt".into(), json!(iso(now)));
    details.insert("decision".into(), json!({ "basis": BASIS }));
    let note = price.note.trim();
    details.insert(
        "manualPrice".into(),
        json!({
            "price": dollars,
            "note": if note.is_empty() { Value::Null } else { note.into() },
            "enteredAt": iso(now),
            "pricingErrors": errors,
            "pricingWarnings": warnings,
        }),
    );
    (row, Value::Object(details))
}

/// Whether `batch` is queued or pricing, which would replace what is decided for a result, with
/// the batch locked until the caller's transaction ends; `None` when there is no such batch.
async fn pricing(conn: &mut PgConnection, batch: i32) -> sqlx::Result<Option<bool>> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM inventory_batch_pricing_jobs job
           WHERE job.batch_number = b.batch_number AND job.status IN ('queued', 'pricing'))
         FROM inventory_batches b WHERE b.batch_number = $1 FOR UPDATE",
    )
    .bind(batch)
    .fetch_optional(&mut *conn)
    .await
}

/// Enters `price` for its SKU's result in `batch`, refreshes the batch's counts and summary, all
/// on `conn` (the caller's transaction). Refused while the batch is queued or pricing, or once the
/// result no longer needs review.
pub async fn enter(
    conn: &mut PgConnection,
    batch: i32,
    price: &ManualPrice,
    now: DateTime<Utc>,
) -> Result<(), NotEntered> {
    match pricing(conn, batch).await? {
        None => return Err(NotEntered::NotForReview),
        Some(true) => return Err(NotEntered::Pricing),
        Some(false) => {}
    }
    type Saved = (Value, Option<Value>, Vec<String>, Vec<String>);
    let saved: Option<Saved> = sqlx::query_as(
        "SELECT row_json, pricing_details_json, error_messages, warning_messages
         FROM inventory_batch_results
         WHERE batch_number = $1 AND sku = $2 AND result_status <> 'successful'
         FOR UPDATE",
    )
    .bind(batch)
    .bind(price.sku)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((row, details, errors, warnings)) = saved else {
        return Err(NotEntered::NotForReview);
    };
    let (row, details) = entered(&row, details.as_ref(), &errors, &warnings, price, now);
    sqlx::query(
        "UPDATE inventory_batch_results
         SET result_status = 'successful', row_json = $3, pricing_details_json = $4,
             error_messages = ARRAY[]::text[], warning_messages = ARRAY[]::text[], priced_at = $5
         WHERE batch_number = $1 AND sku = $2",
    )
    .bind(batch)
    .bind(price.sku)
    .bind(&row)
    .bind(&details)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    save::refresh_counts(conn, batch, now).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn price(cents: i64, note: &str) -> ManualPrice {
        ManualPrice {
            sku: 7,
            price_cents: cents,
            note: note.into(),
        }
    }

    #[test]
    fn an_entered_price_lists_the_row_and_keeps_what_pricing_said() {
        let row = json!({ "TCG Marketplace Price": "", "Error": "No sales", "Warning": "", "Product": "Card" });
        let details =
            json!({ "mode": "errors", "tcgMarketPrice": null, "decision": { "basis": "modeled" } });
        let errors = vec!["No sales".to_owned()];
        let now = at("2026-11-23T15:00:00Z");
        let (row, details) = entered(
            &row,
            Some(&details),
            &errors,
            &[],
            &price(1250, " Comparable listing "),
            now,
        );
        assert_eq!(
            row,
            json!({ "TCG Marketplace Price": "12.50", "Error": "", "Warning": "", "Product": "Card" })
        );
        assert_eq!(details["marketplacePrice"], json!(12.5));
        assert_eq!(details["decision"], json!({ "basis": "manual" }));
        assert_eq!(details["mode"], "errors");
        assert_eq!(
            details["manualPrice"],
            json!({
                "price": 12.5,
                "note": "Comparable listing",
                "enteredAt": "2026-11-23T15:00:00.000Z",
                "pricingErrors": ["No sales"],
                "pricingWarnings": [],
            })
        );
    }

    #[test]
    fn a_result_without_details_gets_them() {
        let (_, details) = entered(
            &json!({}),
            None,
            &[],
            &[],
            &price(5, ""),
            at("2026-11-23T15:00:00Z"),
        );
        assert_eq!(details["marketplacePrice"], json!(0.05));
        assert_eq!(details["manualPrice"]["note"], Value::Null);
    }

    /// On the dev database, in a transaction that is rolled back: a batch with one SKU priced and
    /// one left for review. The price entered makes it successful, the batch's counts follow, the
    /// publication preview finds it eligible at that price, and a second entry is refused, as is
    /// one while the batch prices.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn an_entered_price_clears_the_review_and_can_publish() {
        use crate::features::inventory_publication::{plan::Configuration, preview};
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let batch: i32 = sqlx::query_scalar(
            "INSERT INTO inventory_batches (status, source_type, source_label)
             VALUES ('priced', 'pending_inventory', 'Inventory Manager') RETURNING batch_number",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let catalog = json!({ "Product Line": "Line", "Set Name": "Set", "Product": "Card",
                              "Sku Condition": "Near Mint", "Sku Variant": "Normal" });
        sqlx::query(
            "INSERT INTO inventory_batch_items (batch_number, sku, total_quantity, add_to_quantity,
               product_line_id, set_id, product_id, original_row_json, created_at, updated_at)
             SELECT $1, sku, 0, 1, 1, 1, 100 + sku, $2, NOW(), NOW()
             FROM UNNEST(ARRAY[1, 2]) AS sku",
        )
        .bind(batch)
        .bind(&catalog)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO inventory_batch_pricing_jobs (batch_number, mode, status, config_json)
             VALUES ($1, 'full', 'completed', '{}'::jsonb)",
        )
        .bind(batch)
        .execute(&mut *tx)
        .await
        .unwrap();
        let mut errored = catalog.clone();
        errored["TCG Marketplace Price"] = "".into();
        errored["Error"] = "No usable sales history".into();
        let mut priced = catalog.clone();
        priced["TCG Marketplace Price"] = "3.00".into();
        sqlx::query(
            "INSERT INTO inventory_batch_results (batch_number, sku, result_status, row_json,
               pricing_details_json, error_messages, priced_at)
             VALUES ($1, 1, 'successful', $2, '{\"marketplacePrice\": 3}'::jsonb, '{}', NOW()),
                    ($1, 2, 'manual_review', $3, '{}'::jsonb, ARRAY['No usable sales history'], NOW())",
        )
        .bind(batch)
        .bind(&priced)
        .bind(&errored)
        .execute(&mut *tx)
        .await
        .unwrap();
        save::refresh_counts(&mut tx, batch, Utc::now())
            .await
            .unwrap();

        let review = needing_review(&mut tx, batch).await.unwrap();
        assert_eq!(review.total, 1);
        let listed = &review.listed[0];
        assert_eq!((listed.sku, listed.quantity), (2, 1));
        assert_eq!(listed.condition, "Near Mint");
        assert_eq!(listed.errors, vec!["No usable sales history".to_owned()]);

        let entry = ManualPrice {
            sku: 2,
            price_cents: 450,
            note: "Comparable listing".into(),
        };
        enter(&mut tx, batch, &entry, Utc::now()).await.unwrap();
        let counts: (i32, i32) = sqlx::query_as(
            "SELECT successful_count, manual_review_count FROM inventory_batches WHERE batch_number = $1",
        )
        .bind(batch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(counts, (2, 0));
        assert_eq!(needing_review(&mut tx, batch).await.unwrap().total, 0);

        let (found, items, results) = preview::load(&mut tx, batch).await.unwrap().unwrap();
        let policy = Configuration::load(&mut tx).await.unwrap().policy;
        let known = preview::known(&mut tx, batch, &items, &results, None)
            .await
            .unwrap();
        let shown =
            preview::preview(&found, &items, &results, &known, &policy, Utc::now(), false).unwrap();
        let item = shown.items.iter().find(|i| i.sku == 2).unwrap();
        assert!(item.eligible, "{:?}", item.reasons);
        assert_eq!(item.desired_price, Some(4.5));

        assert!(matches!(
            enter(&mut tx, batch, &entry, Utc::now()).await,
            Err(NotEntered::NotForReview)
        ));
        sqlx::query(
            "INSERT INTO inventory_batch_pricing_jobs (batch_number, mode, status, config_json)
             VALUES ($1, 'errors', 'queued', '{}'::jsonb)",
        )
        .bind(batch)
        .execute(&mut *tx)
        .await
        .unwrap();
        assert!(matches!(
            enter(&mut tx, batch, &ManualPrice { sku: 1, ..entry }, Utc::now()).await,
            Err(NotEntered::Pricing)
        ));
        tx.rollback().await.unwrap();
    }
}
