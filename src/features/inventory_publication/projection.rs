//! What a confirmed publication tells the rest of the app (the worker's `recordPublishedPrices`).
//! Received inventory published to the seller continuous pricing tracks becomes that SKU's
//! published price, held until its next pricing is due, and the pricing curve the strategy reads.
//! A continuous publication's prices become the SKUs' published prices, and a SKU Seller Portal
//! answered ambiguously, or whose product details did not match, is paused for review.
use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgConnection;

use super::store::{ItemOutcome, Outcome, Publication};
use crate::features::continuous_pricing::store::Settings as Schedule;

/// The error code of an item whose product details Seller Portal said did not match.
pub const PRODUCT_DETAILS_MISMATCH: &str = "seller_portal_product_details_mismatch";

/// A date as JavaScript holds it: to the millisecond.
fn millis(at: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(at.timestamp_millis()).unwrap_or(at)
}

fn ids(outcomes: &[ItemOutcome], matches: impl Fn(&ItemOutcome) -> bool) -> HashSet<i64> {
    outcomes
        .iter()
        .filter(|o| matches(o))
        .map(|o| o.item_id)
        .collect()
}

/// Records what `publication` (as it stands after its last move) published.
pub async fn record(
    conn: &mut PgConnection,
    publication: &Publication,
    outcomes: &[ItemOutcome],
) -> sqlx::Result<()> {
    let Some(seller) = publication.seller_key.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let published = ids(outcomes, |o| o.outcome == Outcome::Published);
    let skus = |chosen: &HashSet<i64>| -> Vec<i32> {
        publication
            .items
            .iter()
            .filter(|item| chosen.contains(&item.id))
            .map(|item| item.sku)
            .collect()
    };
    match publication.source_type.as_str() {
        "pending_inventory" => {
            let stored: Option<Value> = sqlx::query_scalar(
                "SELECT settings_json -> 'continuousPricing' FROM inventory_publication_settings
                 WHERE config_key = 'default'",
            )
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
            let schedule = Schedule::of(&stored.unwrap_or(Value::Null));
            if schedule.seller_key != seller {
                return Ok(());
            }
            let live: Vec<_> = publication
                .items
                .iter()
                .filter_map(|item| match item.published_at {
                    Some(at) if published.contains(&item.id) => Some((item, at)),
                    _ => None,
                })
                .collect();
            if !live.is_empty() {
                sqlx::query(
                    "WITH observation AS (
                       SELECT * FROM UNNEST($2::int[], $3::float8[], $4::timestamptz[], $5::timestamptz[])
                         AS value(sku, price, priced_at, published_at)
                     )
                     UPDATE continuous_pricing_inventory inventory
                     SET current_price = observation.price,
                         last_priced_at = GREATEST(COALESCE(inventory.last_priced_at, observation.priced_at),
                           observation.priced_at),
                         last_published_price = observation.price,
                         last_published_at = observation.published_at,
                         next_price_at = GREATEST(inventory.next_price_at,
                           observation.published_at + ($6 * INTERVAL '1 minute')),
                         updated_at = NOW()
                     FROM observation
                     WHERE inventory.seller_key = $1 AND inventory.sku = observation.sku
                       AND (inventory.last_published_at IS NULL
                         OR inventory.last_published_at < observation.published_at)",
                )
                .bind(seller)
                .bind(live.iter().map(|(item, _)| item.sku).collect::<Vec<_>>())
                .bind(live.iter().map(|(item, _)| item.desired_price).collect::<Vec<_>>())
                .bind(live.iter().map(|(item, _)| millis(item.priced_at)).collect::<Vec<_>>())
                .bind(live.iter().map(|(_, at)| millis(*at)).collect::<Vec<_>>())
                .bind(schedule.minimum_interval_minutes as f64)
                .execute(&mut *conn)
                .await?;
            }
            let published_skus = skus(&published);
            if let (Some(batch), false) = (publication.batch_number, published_skus.is_empty()) {
                sqlx::query(
                    "INSERT INTO inventory_strategy_pricing_curves
                       (seller_key, sku, batch_number, pricing_details_json, priced_at, updated_at)
                     SELECT $1, result.sku, result.batch_number, result.pricing_details_json,
                       result.priced_at, NOW()
                     FROM inventory_batch_results result
                     WHERE result.batch_number = $2 AND result.sku = ANY($3::int[])
                       AND result.result_status = 'successful' AND result.pricing_details_json IS NOT NULL
                       AND CASE WHEN jsonb_typeof(result.pricing_details_json->'percentiles') = 'array'
                         THEN jsonb_array_length(result.pricing_details_json->'percentiles') > 0
                         ELSE FALSE END
                     ON CONFLICT (seller_key, sku) DO UPDATE SET
                       batch_number = EXCLUDED.batch_number,
                       pricing_details_json = EXCLUDED.pricing_details_json,
                       priced_at = EXCLUDED.priced_at, updated_at = NOW()
                     WHERE inventory_strategy_pricing_curves.priced_at <= EXCLUDED.priced_at",
                )
                .bind(seller)
                .bind(batch)
                .bind(&published_skus)
                .execute(&mut *conn)
                .await?;
            }
        }
        "continuous" => {
            for item in publication
                .items
                .iter()
                .filter(|i| published.contains(&i.id))
            {
                sqlx::query(
                    "UPDATE continuous_pricing_inventory
                     SET current_price = $3::numeric, last_published_price = $3::numeric,
                         last_published_at = NOW(), updated_at = NOW()
                     WHERE seller_key = $1 AND sku = $2",
                )
                .bind(seller)
                .bind(item.sku)
                // The number as its shortest text, which the column reads exactly.
                .bind(item.desired_price.to_string())
                .execute(&mut *conn)
                .await?;
            }
            let pause = |skus: Vec<i32>, reason: &'static str| (skus, reason);
            for (skus, reason) in [
                pause(
                    skus(&ids(outcomes, |o| o.outcome == Outcome::Ambiguous)),
                    "Ambiguous publication outcome requires reconciliation.",
                ),
                pause(
                    skus(&ids(outcomes, |o| {
                        o.outcome == Outcome::Failed
                            && o.error_code.as_deref() == Some(PRODUCT_DETAILS_MISMATCH)
                    })),
                    "Seller product details do not match this SKU; review required.",
                ),
            ] {
                if skus.is_empty() {
                    continue;
                }
                sqlx::query(
                    "UPDATE continuous_pricing_inventory SET pause_reason = $3, updated_at = NOW()
                     WHERE seller_key = $1 AND sku = ANY($2::int[])",
                )
                .bind(seller)
                .bind(&skus)
                .bind(reason)
                .execute(&mut *conn)
                .await?;
            }
        }
        _ => {}
    }
    Ok(())
}
