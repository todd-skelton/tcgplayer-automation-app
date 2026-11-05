//! The ledgers pricing keeps as it reads (`productSalesLedger`, `productWeeklySalesLedger`,
//! `productListingSnapshotsLedger`): each sale once, each SKU's traded weeks from the annual price
//! history, and per condition each day how many sellers ask and the two cheapest delivered prices.
//! The reads are already made to price, so the ledgers cost no request. Recording is best effort:
//! it runs beside the price and a failure is logged, never the price's.
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde::Deserialize;
use sqlx::{PgConnection, QueryBuilder};

use super::{sale::Sale, sku_price::Sku, supply_analysis::Listing};
use crate::database::Database;

/// The most rows one insert carries, as Node's `MAX_ROWS_PER_INSERT`.
const ROWS_PER_INSERT: usize = 1000;

/// A week of the annual price history, with the figures the weekly ledger keeps.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryWeek {
    pub bucket_start_date: String,
    pub transaction_count: String,
    pub quantity_sold: Option<String>,
    pub low_sale_price: Option<String>,
    pub high_sale_price: Option<String>,
    pub low_sale_price_with_shipping: Option<String>,
    pub high_sale_price_with_shipping: Option<String>,
    pub market_price: Option<String>,
}

/// One SKU's weeks in the annual price history.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HistorySku {
    pub sku_id: String,
    pub condition: String,
    pub variant: Option<String>,
    pub language: Option<String>,
    pub buckets: Vec<HistoryWeek>,
}

/// Every sale of one SKU in one week (`WeeklySales`).
#[derive(Clone, Debug, PartialEq)]
pub struct WeeklySales {
    pub product_id: i64,
    pub sku_id: i64,
    pub condition: String,
    pub variant: String,
    pub language: String,
    pub week_start: NaiveDate,
    pub transactions: i64,
    pub quantity: i64,
    pub low_sale_price: Option<f64>,
    pub high_sale_price: Option<f64>,
    pub low_sale_price_with_shipping: Option<f64>,
    pub high_sale_price_with_shipping: Option<f64>,
    pub tcg_market_price: Option<f64>,
}

/// The competing asks for one condition of a product on one day (`ListingSnapshot`).
#[derive(Clone, Debug, PartialEq)]
pub struct ListingSnapshot {
    pub product_id: i64,
    pub variant: String,
    pub language: String,
    pub condition: String,
    pub observed_on: NaiveDate,
    pub seller_count: i64,
    pub cheapest_delivered_price: Option<f64>,
    pub second_cheapest_delivered_price: Option<f64>,
}

/// JavaScript's `Number(text)`: blank is 0, text that is not a number is NaN.
fn number(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() {
        0.0
    } else {
        text.parse().unwrap_or(f64::NAN)
    }
}

/// A price the history reports, kept only when it is a positive number.
fn price(text: Option<&str>) -> Option<f64> {
    text.map(number).filter(|p| p.is_finite() && *p > 0.0)
}

/// The day a week starts, as `new Date(Date.parse(text)).toISOString().slice(0, 10)` reads it
/// on a server in UTC.
fn day(text: &str) -> Option<NaiveDate> {
    let text = text.trim();
    DateTime::parse_from_rfc3339(text)
        .map(|t| t.with_timezone(&Utc).date_naive())
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|t| t.date())
        })
        .or_else(|| NaiveDate::parse_from_str(text, "%Y-%m-%d").ok())
}

/// The traded weeks in a price history, ready to record (`weeklySalesFromHistory`).
pub fn weekly_sales(product_id: i64, history: &[HistorySku]) -> Vec<WeeklySales> {
    history
        .iter()
        .flat_map(|entry| {
            let sku_id = number(&entry.sku_id);
            let sku_ok = sku_id > 0.0;
            entry.buckets.iter().filter_map(move |bucket| {
                let transactions = number(&bucket.transaction_count);
                // NaN, zero and fewer are not a traded week.
                if !sku_ok || transactions.is_nan() || transactions <= 0.0 {
                    return None;
                }
                let quantity = bucket.quantity_sold.as_deref().map_or(0.0, number);
                Some(WeeklySales {
                    product_id,
                    sku_id: sku_id as i64,
                    condition: entry.condition.clone(),
                    variant: entry.variant.clone().unwrap_or_default(),
                    language: entry.language.clone().unwrap_or_default(),
                    week_start: day(&bucket.bucket_start_date)?,
                    transactions: transactions as i64,
                    quantity: if quantity.is_finite() {
                        quantity.max(0.0) as i64
                    } else {
                        0
                    },
                    low_sale_price: price(bucket.low_sale_price.as_deref()),
                    high_sale_price: price(bucket.high_sale_price.as_deref()),
                    low_sale_price_with_shipping: price(
                        bucket.low_sale_price_with_shipping.as_deref(),
                    ),
                    high_sale_price_with_shipping: price(
                        bucket.high_sale_price_with_shipping.as_deref(),
                    ),
                    tcg_market_price: price(bucket.market_price.as_deref()),
                })
            })
        })
        .collect()
}

/// One row per condition: how many sellers ask, and the two cheapest delivered prices
/// (`summarizeListingsByCondition`), conditions in the order first seen.
pub fn snapshots(sku: &Sku, listings: &[Listing], observed_on: NaiveDate) -> Vec<ListingSnapshot> {
    let mut by_condition: Vec<(&str, Vec<f64>)> = Vec::new();
    for listing in listings {
        match by_condition
            .iter_mut()
            .find(|(c, _)| *c == listing.condition)
        {
            Some((_, prices)) => prices.push(listing.delivered()),
            None => by_condition.push((&listing.condition, vec![listing.delivered()])),
        }
    }
    by_condition
        .into_iter()
        .map(|(condition, mut prices)| {
            prices.sort_by(f64::total_cmp);
            ListingSnapshot {
                product_id: sku.product_id,
                variant: sku.variant.clone(),
                language: sku.language.clone(),
                condition: condition.to_owned(),
                observed_on,
                seller_count: prices.len() as i64,
                cheapest_delivered_price: prices.first().copied(),
                second_cheapest_delivered_price: prices.get(1).copied(),
            }
        })
        .collect()
}

/// The sales the sales ledger keeps: a quantity and a date it can read.
pub fn recordable(sales: &[Sale]) -> Vec<&Sale> {
    sales
        .iter()
        .filter(|s| s.quantity > 0.0 && s.timestamp().is_finite())
        .collect()
}

/// Keeps each sale once; a sale seen again is ignored. Answers how many were new.
pub async fn record_sales(
    conn: &mut PgConnection,
    product_id: i64,
    sales: &[Sale],
) -> sqlx::Result<u64> {
    let mut written = 0;
    for rows in recordable(sales).chunks(ROWS_PER_INSERT) {
        let mut insert = QueryBuilder::new(
            "INSERT INTO product_sales (product_id, order_date, condition, variant, language, \
             quantity, purchase_price, shipping_price, listing_type, custom_listing_id) ",
        );
        insert.push_values(rows, |mut row, sale| {
            row.push_bind(product_id as i32)
                .push_bind(&sale.order_date)
                .push_unseparated("::timestamptz")
                .push_bind(&sale.condition)
                .push_bind(&sale.variant)
                .push_bind(&sale.language)
                .push_bind(sale.quantity as i32)
                .push_bind(sale.purchase_price)
                .push_bind(sale.shipping_price)
                .push_bind(&sale.listing_type)
                .push_bind(&sale.custom_listing_id);
        });
        insert.push(" ON CONFLICT DO NOTHING");
        written += insert.build().execute(&mut *conn).await?.rows_affected();
    }
    Ok(written)
}

/// Writes each traded week once and rewrites a week whose figures changed. Answers how many were
/// written.
pub async fn record_weeks(conn: &mut PgConnection, weeks: &[WeeklySales]) -> sqlx::Result<u64> {
    let mut written = 0;
    for rows in weeks.chunks(ROWS_PER_INSERT) {
        let mut insert = QueryBuilder::new(
            "INSERT INTO product_weekly_sales (sku_id, product_id, condition, variant, language, \
             week_start, transactions, quantity, low_sale_price, high_sale_price, \
             low_sale_price_with_shipping, high_sale_price_with_shipping, tcg_market_price) ",
        );
        insert.push_values(rows, |mut row, week| {
            row.push_bind(week.sku_id as i32)
                .push_bind(week.product_id as i32)
                .push_bind(&week.condition)
                .push_bind(&week.variant)
                .push_bind(&week.language)
                .push_bind(week.week_start)
                .push_bind(week.transactions as i32)
                .push_bind(week.quantity as i32)
                .push_bind(week.low_sale_price)
                .push_bind(week.high_sale_price)
                .push_bind(week.low_sale_price_with_shipping)
                .push_bind(week.high_sale_price_with_shipping)
                .push_bind(week.tcg_market_price);
        });
        insert.push(
            " ON CONFLICT (sku_id, week_start) DO UPDATE SET \
             transactions = EXCLUDED.transactions, quantity = EXCLUDED.quantity, \
             low_sale_price = EXCLUDED.low_sale_price, high_sale_price = EXCLUDED.high_sale_price, \
             low_sale_price_with_shipping = EXCLUDED.low_sale_price_with_shipping, \
             high_sale_price_with_shipping = EXCLUDED.high_sale_price_with_shipping, \
             tcg_market_price = EXCLUDED.tcg_market_price, updated_at = NOW() \
             WHERE product_weekly_sales.transactions IS DISTINCT FROM EXCLUDED.transactions \
             OR product_weekly_sales.quantity IS DISTINCT FROM EXCLUDED.quantity \
             OR product_weekly_sales.low_sale_price IS DISTINCT FROM EXCLUDED.low_sale_price \
             OR product_weekly_sales.high_sale_price IS DISTINCT FROM EXCLUDED.high_sale_price \
             OR product_weekly_sales.low_sale_price_with_shipping IS DISTINCT FROM EXCLUDED.low_sale_price_with_shipping \
             OR product_weekly_sales.high_sale_price_with_shipping IS DISTINCT FROM EXCLUDED.high_sale_price_with_shipping \
             OR product_weekly_sales.tcg_market_price IS DISTINCT FROM EXCLUDED.tcg_market_price",
        );
        written += insert.build().execute(&mut *conn).await?.rows_affected();
    }
    Ok(written)
}

/// Keeps one snapshot per condition per day; a later look the same day replaces the earlier one.
pub async fn record_snapshots(
    conn: &mut PgConnection,
    snapshots: &[ListingSnapshot],
) -> sqlx::Result<u64> {
    let mut written = 0;
    for rows in snapshots.chunks(ROWS_PER_INSERT) {
        let mut insert = QueryBuilder::new(
            "INSERT INTO product_listing_snapshots (product_id, variant, language, condition, \
             observed_on, seller_count, cheapest_delivered_price, second_cheapest_delivered_price) ",
        );
        insert.push_values(rows, |mut row, s| {
            row.push_bind(s.product_id as i32)
                .push_bind(&s.variant)
                .push_bind(&s.language)
                .push_bind(&s.condition)
                .push_bind(s.observed_on)
                .push_bind(s.seller_count as i32)
                .push_bind(s.cheapest_delivered_price)
                .push_bind(s.second_cheapest_delivered_price);
        });
        insert.push(
            " ON CONFLICT (product_id, variant, language, condition, observed_on) DO UPDATE SET \
             seller_count = EXCLUDED.seller_count, \
             cheapest_delivered_price = EXCLUDED.cheapest_delivered_price, \
             second_cheapest_delivered_price = EXCLUDED.second_cheapest_delivered_price, \
             observed_at = NOW()",
        );
        written += insert.build().execute(&mut *conn).await?.rows_affected();
    }
    Ok(written)
}

/// Runs a ledger write beside the price: its failure is logged as `what` and goes no further.
pub fn in_background<F, Fut>(db: &Database, what: String, write: F)
where
    F: FnOnce(sqlx::pool::PoolConnection<sqlx::Postgres>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = sqlx::Result<u64>> + Send,
{
    let pool = db.0.clone();
    tokio::spawn(async move {
        let written = async { write(pool.acquire().await?).await };
        if let Err(why) = written.await {
            eprintln!("Recording {what} failed: {why}");
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::Connection;

    use super::*;

    fn sku() -> Sku {
        Sku {
            sku: 1,
            product_id: 42,
            product_line_id: 3,
            condition: "Near Mint".into(),
            variant: "Normal".into(),
            language: "English".into(),
        }
    }

    fn ask(condition: &str, price: f64, shipping: f64) -> Listing {
        Listing {
            condition: condition.into(),
            price,
            shipping_cost: shipping,
            ..Listing::default()
        }
    }

    fn history() -> Vec<HistorySku> {
        serde_json::from_value(json!([
            { "skuId": "7", "condition": "Near Mint", "variant": "Normal", "language": "English",
              "buckets": [
                { "bucketStartDate": "2026-10-26", "transactionCount": "3", "quantitySold": "4",
                  "lowSalePrice": "1.50", "highSalePrice": "0", "marketPrice": "2.10" },
                { "bucketStartDate": "2026-10-19", "transactionCount": "0", "quantitySold": "0" },
                { "bucketStartDate": "not a date", "transactionCount": "2" }
              ] },
            { "skuId": "0", "condition": "Played",
              "buckets": [{ "bucketStartDate": "2026-10-26", "transactionCount": "5" }] }
        ]))
        .unwrap()
    }

    #[test]
    fn only_traded_weeks_of_known_skus_are_kept() {
        let weeks = weekly_sales(42, &history());
        assert_eq!(
            weeks,
            vec![WeeklySales {
                product_id: 42,
                sku_id: 7,
                condition: "Near Mint".into(),
                variant: "Normal".into(),
                language: "English".into(),
                week_start: NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(),
                transactions: 3,
                quantity: 4,
                low_sale_price: Some(1.5),
                // A price of 0 says nothing was reported.
                high_sale_price: None,
                low_sale_price_with_shipping: None,
                high_sale_price_with_shipping: None,
                tcg_market_price: Some(2.1),
            }]
        );
    }

    #[test]
    fn a_week_start_reads_as_node_reads_it_in_utc() {
        assert_eq!(
            day("2026-10-26T00:00:00Z"),
            NaiveDate::from_ymd_opt(2026, 10, 26)
        );
        assert_eq!(
            day("2026-10-26T03:00:00+05:00"),
            NaiveDate::from_ymd_opt(2026, 10, 25)
        );
        assert_eq!(
            day("2026-10-26T00:00:00"),
            NaiveDate::from_ymd_opt(2026, 10, 26)
        );
        assert_eq!(day(""), None);
    }

    #[test]
    fn a_snapshot_per_condition_counts_sellers_and_keeps_the_two_cheapest_delivered() {
        let today = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let listings = [
            ask("Near Mint", 3.0, 1.0),
            ask("Lightly Played", 2.0, 0.0),
            ask("Near Mint", 1.0, 0.99),
            ask("Near Mint", 2.5, 0.0),
        ];
        let rows = snapshots(&sku(), &listings, today);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].condition, "Near Mint");
        assert_eq!(rows[0].seller_count, 3);
        assert_eq!(rows[0].cheapest_delivered_price, Some(1.99));
        assert_eq!(rows[0].second_cheapest_delivered_price, Some(2.5));
        assert_eq!(rows[1].condition, "Lightly Played");
        assert_eq!(rows[1].seller_count, 1);
        assert_eq!(rows[1].second_cheapest_delivered_price, None);
    }

    #[test]
    fn a_sale_without_a_quantity_or_a_readable_date_is_not_kept() {
        let sale = |quantity: f64, order_date: &str| Sale {
            quantity,
            order_date: order_date.into(),
            ..Sale::default()
        };
        let sales = [
            sale(1.0, "2026-11-01T10:00:00+00:00"),
            sale(0.0, "2026-11-01T10:00:00+00:00"),
            sale(2.0, "yesterday"),
        ];
        assert_eq!(recordable(&sales).len(), 1);
    }

    /// The three writes as Node's repositories make them: a sale seen again is ignored, a week
    /// rewritten only when its figures change, a later snapshot the same day replaces the first.
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn the_ledgers_are_written_as_node_writes_them() {
        crate::config::load_env();
        let mut conn = PgConnection::connect(&crate::config::database_url())
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let product_id = 2_000_000_001;
        let sale = Sale {
            condition: "Near Mint".into(),
            variant: "Normal".into(),
            language: "English".into(),
            quantity: 2.0,
            purchase_price: 1.25,
            shipping_price: 0.99,
            order_date: "2026-11-01T10:00:00+00:00".into(),
            ..Sale::default()
        };
        let sales = [sale.clone(), sale];
        assert_eq!(record_sales(&mut tx, product_id, &sales).await.unwrap(), 1);
        assert_eq!(
            record_sales(&mut tx, product_id, &sales[..1])
                .await
                .unwrap(),
            0
        );

        let mut weeks = weekly_sales(product_id, &history());
        weeks[0].sku_id = 2_000_000_007;
        assert_eq!(record_weeks(&mut tx, &weeks).await.unwrap(), 1);
        assert_eq!(record_weeks(&mut tx, &weeks).await.unwrap(), 0);
        weeks[0].quantity = 5;
        assert_eq!(record_weeks(&mut tx, &weeks).await.unwrap(), 1);

        let today = NaiveDate::from_ymd_opt(2026, 11, 3).unwrap();
        let mut owned = sku();
        owned.product_id = product_id;
        let first = snapshots(&owned, &[ask("Near Mint", 1.0, 0.0)], today);
        let later = snapshots(
            &owned,
            &[ask("Near Mint", 2.0, 0.0), ask("Near Mint", 3.0, 0.0)],
            today,
        );
        assert_eq!(record_snapshots(&mut tx, &first).await.unwrap(), 1);
        assert_eq!(record_snapshots(&mut tx, &later).await.unwrap(), 1);
        let (count, cheapest, second): (i32, f64, f64) = sqlx::query_as(
            "SELECT seller_count, cheapest_delivered_price::float8, second_cheapest_delivered_price::float8
             FROM product_listing_snapshots WHERE product_id = $1",
        )
        .bind(product_id as i32)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!((count, cheapest, second), (2, 2.0, 3.0));
        let (price, at): (f64, DateTime<Utc>) = sqlx::query_as(
            "SELECT purchase_price::float8, order_date FROM product_sales WHERE product_id = $1",
        )
        .bind(product_id as i32)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(price, 1.25);
        assert_eq!(at.to_rfc3339(), "2026-11-01T10:00:00+00:00");
        tx.rollback().await.unwrap();
    }
}
