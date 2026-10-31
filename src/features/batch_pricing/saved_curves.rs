//! Saved-curve repricing, a job's `cached` mode: a continuous batch's SKUs priced again from the
//! curves their last pricing saved, with no sales read. A SKU whose curve can no longer be reused
//! (another model, an old reading, other supply settings) is made due for a full pricing instead.
//! Ported from `findReusableSnapshots`, `deferBatchItemsToRefresh` and
//! `createCachedSuggestedPriceResolver`.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::types::Json;

use super::job::{Display, PricePoint};
use crate::{
    database::Database,
    features::pricing::{
        calculator::{Request, Resolve, Resolved, days},
        policy::{
            Curve, MODEL_VERSION, PercentileDetail, PersistedDecision, Policy, select_decision,
            to_pricing_curve,
        },
        sku_price::Failure,
    },
};

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// What a saved curve must meet to be priced from again (`reusablePricingCurveWhere`): the
/// current model, a modeled decision with a forecast, the same supply settings as the job that
/// priced it, market data no older than the schedule's interval, and at least one percentile.
/// `$2` is the model version, `$3` the interval in minutes, `$4` the supply settings, `$6` the
/// time it is read as of: Node's `NOW()`, bound so a run priced as of a past time reads as then.
pub const REUSABLE: &str = "
  curve.pricing_details_json->>'pricingModelVersion' = $2
  AND curve.pricing_details_json->'decision'->>'basis' = 'modeled'
  AND curve.pricing_details_json->'decision'->>'forecastStatus' <> 'unavailable'
  AND (
    SELECT job.config_json->'supplyAnalysis'
    FROM inventory_batch_pricing_jobs job
    WHERE job.batch_number = curve.batch_number
      AND job.created_at <= curve.priced_at
    ORDER BY job.created_at DESC, job.id DESC LIMIT 1
  ) = $4::jsonb
  AND COALESCE(
    (curve.pricing_details_json->>'marketDataAt')::timestamptz,
    curve.priced_at
  ) BETWEEN $6::timestamptz - ($3 * INTERVAL '1 minute') AND $6::timestamptz
  AND CASE
    WHEN jsonb_typeof(curve.pricing_details_json->'percentiles') = 'array'
    THEN jsonb_array_length(curve.pricing_details_json->'percentiles') > 0
    ELSE FALSE
  END";

/// A SKU's curve that can be priced from again, with what the seller's inventory says of it.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedCurve {
    pub sku: i64,
    pub display: Display,
    pub market_price: Option<f64>,
    pub details: Value,
    /// When the curve's market data was read.
    pub market_data_at: DateTime<Utc>,
}

impl SavedCurve {
    fn figure(&self, key: &str) -> Option<f64> {
        self.details.get(key).and_then(Value::as_f64)
    }

    pub fn lowest_sale_price(&self) -> Option<f64> {
        self.figure("lowestSalePrice")
    }

    pub fn highest_sale_price(&self) -> Option<f64> {
        self.figure("highestSalePrice")
    }

    /// The market data the calculator reads for it, when the inventory has a market price.
    pub fn price_point(&self) -> Option<PricePoint> {
        Some(PricePoint {
            market_price: self.market_price?,
            lowest_price: self.lowest_sale_price().unwrap_or(0.0),
            highest_price: self.highest_sale_price().unwrap_or(0.0),
            price_count: 0.0,
        })
    }
}

type Row = (
    i64,
    String,
    String,
    String,
    String,
    String,
    Option<f64>,
    Json<Value>,
    DateTime<Utc>,
);

/// The seller's curves among `skus` that can be priced from again as of `now`, for a job queued
/// with `supply_analysis`.
pub async fn reusable(
    db: &Database,
    seller: &str,
    skus: &[i64],
    minimum_interval_minutes: i64,
    supply_analysis: &Value,
    now: DateTime<Utc>,
) -> sqlx::Result<Vec<SavedCurve>> {
    if skus.is_empty() {
        return Ok(Vec::new());
    }
    let skus: Vec<i32> = skus.iter().filter_map(|s| i32::try_from(*s).ok()).collect();
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT inventory.sku::bigint, inventory.product_line, inventory.set_name,
           inventory.product_name, inventory.condition, inventory.variant,
           inventory.market_price::float8, curve.pricing_details_json,
           COALESCE((curve.pricing_details_json->>'marketDataAt')::timestamptz, curve.priced_at)
         FROM continuous_pricing_inventory inventory
         JOIN inventory_strategy_pricing_curves curve
           ON curve.seller_key = inventory.seller_key AND curve.sku = inventory.sku
         WHERE inventory.seller_key = $1 AND inventory.sku = ANY($5::int[])
           AND {REUSABLE}"
    ))
    .bind(seller)
    .bind(MODEL_VERSION)
    .bind(minimum_interval_minutes as f64)
    .bind((!supply_analysis.is_null()).then_some(Json(supply_analysis)))
    .bind(&skus)
    .bind(now)
    .fetch_all(&db.0)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| SavedCurve {
            sku: row.0,
            display: Display {
                product_line: row.1,
                set_name: row.2,
                product_name: row.3,
                condition: row.4,
                variant: row.5,
            },
            market_price: row.6,
            details: row.7.0,
            market_data_at: row.8,
        })
        .collect())
}

/// Makes the batch's `skus` due for pricing now, unless they already are.
pub async fn defer_to_refresh(db: &Database, batch_number: i32, skus: &[i64]) -> sqlx::Result<()> {
    if skus.is_empty() {
        return Ok(());
    }
    let skus: Vec<i32> = skus.iter().filter_map(|s| i32::try_from(*s).ok()).collect();
    sqlx::query(
        "UPDATE continuous_pricing_inventory
         SET next_price_at = LEAST(next_price_at, NOW()), updated_at = NOW()
         WHERE last_batch_number = $1 AND sku = ANY($2::int[])",
    )
    .bind(batch_number)
    .bind(&skus)
    .execute(&db.0)
    .await?;
    Ok(())
}

/// Prices each SKU at the requested percentile of its saved curve.
pub struct SavedCurves(HashMap<i64, Value>);

impl SavedCurves {
    pub fn new(curves: &[SavedCurve]) -> Self {
        SavedCurves(curves.iter().map(|c| (c.sku, c.details.clone())).collect())
    }
}

/// A stored field, or none when it is missing or does not read.
fn field<T: serde::de::DeserializeOwned>(details: &Value, key: &str) -> Option<T> {
    serde_json::from_value(details.get(key)?.clone()).ok()
}

/// What the saved details price the SKU at: a curve of the current model at `percentile`.
fn resolve(details: Option<&Value>, percentile: f64) -> Resolved {
    let unavailable = || Resolved {
        error: Some("A compatible saved pricing curve is no longer available.".into()),
        ..Resolved::default()
    };
    let Some(details) = details else {
        return unavailable();
    };
    let persisted = PersistedDecision::from_json(details);
    if persisted.pricing_model_version.as_deref() != Some(MODEL_VERSION) {
        return unavailable();
    }
    let percentiles = persisted.percentiles.unwrap_or_default();
    let curve = Curve::new(to_pricing_curve(&percentiles));
    let Some(decision) = select_decision(&curve, &Policy::Percentile { percentile }, None, None)
    else {
        return unavailable();
    };
    let ms = |days: Option<f64>| days.map(|d| d * DAY_MS);
    // The calculator reads days back from milliseconds, as Node's does from its resolver's.
    let again = |d: Option<f64>| days(ms(d));
    Resolved {
        error: None,
        suggested_price: Some(
            decision
                .unconstrained_price
                .unwrap_or(decision.selected_price),
        ),
        lowest_listing_price: None,
        historical_sales_velocity_ms: ms(decision.buyer_interval_days),
        estimated_time_to_sell_ms: ms(decision.estimated_median_sell_days),
        sales_count: decision.qualifying_sales_count,
        listings_count: decision.listings_count,
        // Node hands the saved forecast on as the rate; the calculator forecasts again from it.
        condition_sale_rate: field(details, "conditionRateForecast"),
        condition_normalization: field(details, "conditionNormalization"),
        price_evidence: field(details, "priceEvidence"),
        percentiles: Some(
            percentiles
                .iter()
                .map(|p| PercentileDetail {
                    historical_sales_velocity_days: again(p.historical_sales_velocity_days),
                    estimated_time_to_sell_days: again(p.estimated_time_to_sell_days),
                    ..p.clone()
                })
                .collect(),
        ),
    }
}

impl Resolve for SavedCurves {
    async fn resolve(&self, request: &Request<'_>) -> Result<Resolved, Failure> {
        Ok(resolve(self.0.get(&request.sku), request.percentile))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn details(version: &str) -> Value {
        json!({
            "pricingModelVersion": version,
            "percentiles": [
                { "percentile": 50, "suggestedPrice": 1.0, "historicalSalesVelocityDays": 10, "estimatedTimeToSellDays": 12, "salesCount": 4 },
                { "percentile": 80, "suggestedPrice": 2.0, "historicalSalesVelocityDays": 20, "estimatedTimeToSellDays": 0, "salesCount": 4 }
            ],
            "conditionRateForecast": { "intervalDays": 7.5, "transactions": 48, "method": "annual-buckets-v1", "medianSellDays": 9 },
            "conditionNormalization": { "method": "sibling-market-ratio", "observationCount": 3, "observedConditionCount": 1, "anchorCondition": "Lightly Played", "conditionTimeConnected": false },
            "lowestSalePrice": 0.75
        })
    }

    #[test]
    fn a_saved_curve_is_priced_at_the_requested_percentile() {
        let resolved = resolve(Some(&details(MODEL_VERSION)), 80.0);
        assert_eq!(resolved.error, None);
        assert_eq!(resolved.suggested_price, Some(2.0));
        assert_eq!(resolved.historical_sales_velocity_ms, Some(20.0 * DAY_MS));
        let rate = resolved.condition_sale_rate.unwrap();
        assert_eq!(
            (rate.interval_days, rate.method.as_str()),
            (7.5, "annual-buckets-v1")
        );
        assert_eq!(
            resolved
                .condition_normalization
                .unwrap()
                .anchor_condition
                .as_deref(),
            Some("Lightly Played")
        );
        let points = resolved.percentiles.unwrap();
        // A zero reads as no time, as JavaScript's truthiness drops it.
        assert_eq!(points[1].estimated_time_to_sell_days, None);
        assert_eq!(points[0].historical_sales_velocity_days, Some(10.0));
    }

    #[test]
    fn a_curve_of_another_model_or_none_is_unavailable() {
        for details in [Some(details("older-model")), None] {
            let resolved = resolve(details.as_ref(), 80.0);
            assert_eq!(resolved.suggested_price, None);
            assert_eq!(
                resolved.error.as_deref(),
                Some("A compatible saved pricing curve is no longer available.")
            );
        }
    }

    #[test]
    fn the_calculator_reads_the_inventory_market_price_and_saved_extremes() {
        let curve = SavedCurve {
            sku: 1,
            display: Display::default(),
            market_price: Some(1.5),
            details: details(MODEL_VERSION),
            market_data_at: Utc::now(),
        };
        let point = curve.price_point().unwrap();
        assert_eq!(
            (point.market_price, point.lowest_price, point.highest_price),
            (1.5, 0.75, 0.0)
        );
        assert_eq!(
            SavedCurve {
                market_price: None,
                ..curve
            }
            .price_point(),
            None
        );
    }

    /// Every curve the strategy saved on dev (`.port-logs/curves.jsonl`), resolved at the
    /// percentile its run used, against what Node's resolver answered for the same curves
    /// (`.port-logs/cached-resolve.ts` writes `cached-resolve.node.json`): the same price, times,
    /// counts and error, and the same percentiles once the calculator reads them back as days.
    #[test]
    #[ignore = "reads curves exported from the dev database and Node's answers for them"]
    fn saved_curves_resolve_as_node_s_resolver_does() {
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let curves: HashMap<i64, Value> = read("curves.jsonl")
            .lines()
            .map(|line| {
                let row: Value = serde_json::from_str(line).unwrap();
                (row["sku"].as_i64().unwrap(), row["details"].clone())
            })
            .collect();
        let node: Vec<Value> = serde_json::from_str(&read("cached-resolve.node.json")).unwrap();
        let mut differences = Vec::new();
        for answer in &node {
            let sku = answer["sku"].as_i64().unwrap();
            let ours = resolve(curves.get(&sku), answer["percentile"].as_f64().unwrap());
            let theirs = &answer["result"];
            let number = |key: &str| theirs.get(key).and_then(Value::as_f64);
            let node_points: Vec<(f64, Option<f64>, Option<f64>)> = theirs["percentiles"]
                .as_array()
                .map(|points| {
                    points
                        .iter()
                        .map(|p| {
                            let ms = |key: &str| days(p.get(key).and_then(Value::as_f64));
                            (
                                p["price"].as_f64().unwrap(),
                                ms("historicalSalesVelocityMs"),
                                ms("estimatedTimeToSellMs"),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let our_points: Vec<(f64, Option<f64>, Option<f64>)> = ours
                .percentiles
                .iter()
                .flatten()
                .map(|p| {
                    (
                        p.suggested_price,
                        p.historical_sales_velocity_days,
                        p.estimated_time_to_sell_days,
                    )
                })
                .collect();
            let same = ours.suggested_price == number("suggestedPrice")
                && ours.historical_sales_velocity_ms == number("historicalSalesVelocityMs")
                && ours.estimated_time_to_sell_ms == number("estimatedTimeToSellMs")
                && ours.sales_count == number("salesCount")
                && ours.listings_count == number("listingsCount")
                && ours.error.as_deref() == theirs["error"].as_str()
                && ours.condition_sale_rate.map(|r| r.interval_days)
                    == theirs["conditionSaleRate"]["intervalDays"].as_f64()
                && ours.condition_normalization.is_some()
                    == theirs["conditionNormalization"].is_object()
                && our_points == node_points;
            if !same {
                differences.push((sku, ours.suggested_price, number("suggestedPrice")));
            }
        }
        println!("{} curves, {} differ", node.len(), differences.len());
        for d in differences.iter().take(10) {
            println!("{d:?}");
        }
        assert!(!node.is_empty());
        assert!(differences.is_empty());
    }

    /// Node's cached pricing of batch 3497 (`.port-logs/cached-run.ts 3497`: as of a minute after
    /// its full run, snaps off, nothing written), priced again here from the same curves: every
    /// SKU's price, suggestion, percentile and market reading, and the summary's totals, match.
    /// Makes the stale SKUs due, as Node does; restore the schedule from a backup after.
    #[tokio::test]
    #[ignore = "uses the dev database and Node's run exported to .port-logs"]
    async fn a_cached_run_prices_as_node_s_does() {
        use crate::features::batch_pricing::{
            job::{self, Mode},
            shadow::{Ledgers, SavedMarket},
        };
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/cached-run-3497.node.json").unwrap(),
        )
        .unwrap();
        let as_of: DateTime<Utc> = node["asOf"].as_str().unwrap().parse().unwrap();
        let batch = job::batch(&db, 3497).await.unwrap();
        let priced = job::price(
            &db,
            &batch,
            Mode::Cached,
            &node["config"],
            &Ledgers { db: &db, as_of },
            &SavedMarket(&[]),
            as_of,
            &mut |_| {},
        )
        .await
        .unwrap();
        let theirs: HashMap<i64, &Value> = node["pricedSkus"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["sku"].as_i64().unwrap(), s))
            .collect();
        let mut differences = Vec::new();
        for sku in &priced.skus {
            let Some(t) = theirs.get(&sku.item.sku) else {
                differences.push(format!("{}: not priced by Node", sku.item.sku));
                continue;
            };
            let n = |key: &str| t.get(key).and_then(Value::as_f64);
            let at = sku
                .market_data_at
                .map(crate::features::inventory_economics::ledger::proceeds::iso);
            let fields = [
                ("price", sku.item.price, n("price")),
                (
                    "suggestedPrice",
                    sku.item.suggested_price,
                    n("suggestedPrice"),
                ),
                (
                    "percentileUsed",
                    sku.item.percentile_used,
                    n("percentileUsed"),
                ),
                ("tcgMarketPrice", sku.tcg_market_price, n("tcgMarketPrice")),
                (
                    "lowestSalePrice",
                    sku.lowest_sale_price,
                    n("lowestSalePrice"),
                ),
                (
                    "highestSalePrice",
                    sku.highest_sale_price,
                    n("highestSalePrice"),
                ),
                ("saleCount", sku.sale_count, n("saleCount")),
                (
                    "historicalSalesVelocityDays",
                    sku.item.historical_sales_velocity_days,
                    n("historicalSalesVelocityDays"),
                ),
                (
                    "estimatedTimeToSellDays",
                    sku.item.estimated_time_to_sell_days,
                    n("estimatedTimeToSellDays"),
                ),
            ];
            for (name, ours, node) in fields {
                if ours != node {
                    differences.push(format!("{}: {name} {ours:?} vs {node:?}", sku.item.sku));
                }
            }
            if at.as_deref() != t["marketDataAt"].as_str() {
                differences.push(format!(
                    "{}: marketDataAt {at:?} vs {}",
                    sku.item.sku, t["marketDataAt"]
                ));
            }
            let words = |v: &Value| -> Vec<String> {
                v.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|w| w.as_str().map(String::from))
                    .collect()
            };
            if sku.item.errors != words(&t["errors"])
                || sku.item.warnings.clone().unwrap_or_default() != words(&t["warnings"])
            {
                differences.push(format!(
                    "{}: errors or warnings {:?} {:?} vs {} {}",
                    sku.item.sku, sku.item.errors, sku.item.warnings, t["errors"], t["warnings"]
                ));
            }
        }
        for key in [
            "totalRows",
            "processedRows",
            "skippedRows",
            "errorRows",
            "warningRows",
        ] {
            if priced.summary[key] != node["summary"][key] {
                differences.push(format!(
                    "summary {key}: {} vs {}",
                    priced.summary[key], node["summary"][key]
                ));
            }
        }
        for key in ["marketPrice", "lowPrice", "marketplacePrice"] {
            let (ours, theirs) = (
                &priced.summary["totals"][key],
                &node["summary"]["totals"][key],
            );
            if ours
                .as_f64()
                .zip(theirs.as_f64())
                .is_none_or(|(a, b)| (a - b).abs() > 1e-9)
            {
                differences.push(format!("totals {key}: {ours} vs {theirs}"));
            }
        }
        println!(
            "{} priced here, {} by Node",
            priced.skus.len(),
            theirs.len()
        );
        for d in &differences {
            println!("{d}");
        }
        assert_eq!(priced.skus.len(), theirs.len());
        assert!(differences.is_empty());
    }
}
