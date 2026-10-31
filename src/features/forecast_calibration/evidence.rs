//! The evidence a calibration is learned from (`forecastCalibrationEvidenceRepository`), read
//! to the millisecond as the Node app's dates hold it.
use chrono::{DateTime, Utc};

use super::{Calibration, DAY_MS, Evidence, ListedPrice, SkuSale, learn, ms};
use crate::{
    database::Database,
    features::pricing::policy::MODEL_VERSION,
    features::{continuous_pricing::store, inventory_economics::ledger::proceeds::iso},
};

/// Sales can't be read as missing when the order history is older than this.
const MAXIMUM_ORDER_HISTORY_AGE_MS: i64 = 2 * DAY_MS;
/// Listings counted before this much ahead of the window still need the sales since their count.
const COUNT_LEAD_MS: i64 = DAY_MS;

fn at(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// `loadForecastCalibration`: the seller's calibration over the trailing `days`, learned at
/// `now`; why not when there is no seller or no current order history.
pub async fn load(db: &Database, days: u32, now: DateTime<Utc>) -> Result<Calibration, String> {
    let e = |e: sqlx::Error| e.to_string();
    let seller = store::settings(db).await.map_err(e)?.seller_key;
    let seller = seller.trim();
    if seller.is_empty() {
        return Err("Set the continuous pricing seller to calibrate sell-time forecasts.".into());
    }
    let coverage: Option<(DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT date_trunc('milliseconds', observed_from), date_trunc('milliseconds', observed_through)
         FROM seller_order_sync_runs
         WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND gaps='[]'::jsonb
           AND observed_from IS NOT NULL AND observed_through IS NOT NULL
         ORDER BY observed_through DESC, id DESC LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&db.0)
    .await
    .map_err(e)?;
    let Some((covered_from, covered_through)) = coverage else {
        return Err("Forecast calibration needs a complete order history sync.".into());
    };
    let now = ms(now);
    if now - ms(covered_through) > MAXIMUM_ORDER_HISTORY_AGE_MS {
        return Err(format!(
            "Order history was last synced through {}; forecast calibration waits for a current sync.",
            iso(covered_through)
        ));
    }
    let through = now.min(ms(covered_through));
    let from = (through - i64::from(days) * DAY_MS).max(ms(covered_from));
    let (prices, sales) = tokio::try_join!(
        listed_prices(db, seller, from, through),
        sku_sales(db, seller, from, through)
    )
    .map_err(e)?;
    Ok(learn(&Evidence {
        seller_key: seller,
        prices: &prices,
        sales: &sales,
        from,
        through,
        learned_at: now,
        evidence_window_days: days,
    }))
}

/// Prices published in the window with a modeled sell-time forecast from the current pricing
/// model, the stock counted for them, and when the SKU's next price replaced them.
async fn listed_prices(
    db: &Database,
    seller: &str,
    from: i64,
    through: i64,
) -> sqlx::Result<Vec<ListedPrice>> {
    sqlx::query_as(
        "WITH published AS (
          SELECT item.sku, item.published_at AS listed_at,
            LEAD(item.published_at) OVER (PARTITION BY item.sku ORDER BY item.published_at, item.id) AS replaced_at,
            batch_item.total_quantity + GREATEST(batch_item.add_to_quantity, 0) AS quantity,
            batch_item.created_at AS counted_at,
            item.forecast_evidence->>'pricingModelVersion' AS pricing_model_version,
            item.forecast_evidence->'decision'->>'basis' AS basis,
            CASE WHEN jsonb_typeof(item.forecast_evidence->'decision'->'estimatedMedianSellDays')='number'
              THEN (item.forecast_evidence->'decision'->>'estimatedMedianSellDays')::float8 END AS median_sell_days
          FROM inventory_publication_items item
          JOIN inventory_publications publication ON publication.id = item.publication_id
          LEFT JOIN inventory_batch_items batch_item
            ON batch_item.batch_number = item.batch_number AND batch_item.sku = item.sku
          WHERE publication.seller_key = $1 AND item.status = 'published'
            AND item.published_at >= $2 AND item.published_at < $3
        )
        SELECT sku, date_trunc('milliseconds', listed_at) AS listed_at,
          date_trunc('milliseconds', replaced_at) AS replaced_at, quantity,
          date_trunc('milliseconds', counted_at) AS counted_at,
          median_sell_days AS forecast_median_sell_days
        FROM published
        WHERE quantity > 0 AND counted_at IS NOT NULL AND basis = 'modeled'
          AND pricing_model_version = $4 AND median_sell_days > 0
        ORDER BY listed_at, sku",
    )
    .bind(seller)
    .bind(at(from))
    .bind(at(through))
    .bind(MODEL_VERSION)
    .fetch_all(&db.0)
    .await
}

/// Copies of each SKU sold per order in the window, and the day before it, not canceled.
async fn sku_sales(
    db: &Database,
    seller: &str,
    from: i64,
    through: i64,
) -> sqlx::Result<Vec<SkuSale>> {
    sqlx::query_as(
        "SELECT line.sku_id::int AS sku, date_trunc('milliseconds', orders.order_time) AS sold_at,
           SUM(line.ordered_quantity)::int AS quantity
         FROM seller_orders orders
         JOIN seller_order_lines line ON line.order_id = orders.id
         WHERE orders.seller_key = $1 AND orders.order_time >= $2 AND orders.order_time < $3
           AND orders.lifecycle <> 'canceled' AND line.ordered_quantity > 0
           AND line.sku_id ~ '^[1-9][0-9]{0,8}$'
         GROUP BY orders.id, line.sku_id, orders.order_time
         ORDER BY orders.order_time, orders.id",
    )
    .bind(seller)
    .bind(at(from - COUNT_LEAD_MS))
    .bind(at(through))
    .fetch_all(&db.0)
    .await
}
