//! What a priced batch writes: each SKU's result status, its row as the CSV export lays it out
//! (`PricedSkuToTcgPlayerListingConverter`), its pricing details (`buildPricingDetails`), and the
//! batch's summary (`buildSummary`), as the Node app writes them.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};

use super::job::{Display, Mode, PricedSku};
use crate::features::{
    configuration::config::Config as StoredConfig,
    inventory_economics::ledger::{assumptions::js_to_fixed, fingerprint::js_float, proceeds::iso},
    pricing::{
        calculator::{Aggregated, Calculation, PricerSku},
        policy::{MODEL_VERSION, Method},
    },
};

const PRICING_DETAILS_SCHEMA_VERSION: u32 = 2;

/// Successful when it has a price and no errors; manual review otherwise.
pub fn status(sku: &PricedSku) -> &'static str {
    let priced = sku.item.price.is_some_and(|p| p > 0.0);
    if priced && sku.item.errors.is_empty() {
        "successful"
    } else {
        "manual_review"
    }
}

fn fixed(value: Option<f64>) -> String {
    value.map(|v| js_to_fixed(v, 2)).unwrap_or_default()
}

fn text(value: Option<f64>) -> String {
    value.map(js_float).unwrap_or_default()
}

/// The SKU's row, every value a string.
pub fn row(sku: &PricedSku) -> Value {
    let item = &sku.item;
    let shown = sku.display.clone().unwrap_or_default();
    let quantity = js_float(item.quantity.unwrap_or(0.0));
    let add = js_float(item.add_to_quantity.unwrap_or(0.0));
    json!({
        "TCGplayer Id": item.sku.to_string(),
        "Product Line": shown.product_line,
        "Set Name": shown.set_name,
        "Product": shown.product_name,
        "Sku Variant": shown.variant,
        "Sku Condition": shown.condition,
        "Sale Count": text(sku.sale_count),
        "Lowest Sale Price": fixed(sku.lowest_sale_price),
        "Highest Sale Price": fixed(sku.highest_sale_price),
        "TCG Market Price": fixed(sku.tcg_market_price),
        "Total Quantity": quantity,
        "Add to Quantity": add,
        "TCG Marketplace Price": fixed(item.price),
        "Previous Price": fixed(item.previous_price),
        "Suggested Price": fixed(item.suggested_price),
        "Percentile Used": text(item.percentile_used),
        "Historical Sales Velocity (Days)": text(item.historical_sales_velocity_days),
        "Estimated Time to Sell (Days)": text(item.estimated_time_to_sell_days),
        "Sales Count for Historical Calculation": text(item.sales_count_for_historical),
        "Listings Count for Estimated Calculation": text(item.listings_count_for_estimated),
        "Error": item.errors.join("; "),
        "Warning": item.warnings.as_deref().unwrap_or_default().join("; "),
    })
}

fn put(details: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value.filter(|v| !v.is_null()) {
        details.insert(key.into(), value);
    }
}

/// The SKU's pricing details as the worker saves them.
pub fn details(
    sku: &PricedSku,
    mode: Mode,
    priced_at: DateTime<Utc>,
    stored: &StoredConfig,
) -> Value {
    let item = serde_json::to_value(&sku.item).expect("a priced item serializes");
    let field = |key: &str| item.get(key).cloned();
    let number = |value: Option<f64>| value.map(|v| json!(v));
    let mut d = Map::new();
    d.insert(
        "schemaVersion".into(),
        json!(PRICING_DETAILS_SCHEMA_VERSION),
    );
    d.insert("pricingModelVersion".into(), json!(MODEL_VERSION));
    d.insert("mode".into(), json!(mode.as_str()));
    d.insert("pricedAt".into(), json!(iso(priced_at)));
    d.insert(
        "marketDataAt".into(),
        json!(iso(sku.market_data_at.unwrap_or(priced_at))),
    );
    put(&mut d, "productLineId", field("productLineId"));
    put(&mut d, "percentileUsed", field("percentileUsed"));
    put(&mut d, "suggestedPrice", field("suggestedPrice"));
    put(&mut d, "marketplacePrice", field("price"));
    put(&mut d, "previousPrice", field("previousPrice"));
    put(&mut d, "tcgMarketPrice", number(sku.tcg_market_price));
    put(&mut d, "lowestSalePrice", number(sku.lowest_sale_price));
    put(&mut d, "highestSalePrice", number(sku.highest_sale_price));
    put(&mut d, "quantity", field("quantity"));
    put(&mut d, "addToQuantity", field("addToQuantity"));
    for key in [
        "historicalSalesVelocityDays",
        "estimatedTimeToSellDays",
        "salesCountForHistorical",
        "listingsCountForEstimated",
        "percentiles",
        "buyerChoiceForecast",
        "conditionRateForecast",
        "conditionNormalization",
        "priceEvidence",
    ] {
        put(&mut d, key, field(key));
    }
    d.insert(
        "warnings".into(),
        field("warnings").unwrap_or_else(|| json!([])),
    );
    d.insert(
        "errors".into(),
        field("errors").unwrap_or_else(|| json!([])),
    );
    d.insert(
        "featureFlags".into(),
        json!({ "supplyAnalysis": stored.supply.enabled }),
    );
    put(&mut d, "policy", policy(sku, stored));
    put(&mut d, "decision", field("pricingDecision"));
    put(&mut d, "shadowDecision", field("shadowPricingDecision"));
    Value::Object(d)
}

/// The policy the SKU's decision was made under, with the hurdle or horizon it used.
fn policy(sku: &PricedSku, stored: &StoredConfig) -> Option<Value> {
    let decision = sku.item.pricing_decision.as_ref()?;
    match decision.method {
        Method::TargetHorizon => decision
            .target_horizon_days
            .map(|days| json!({ "method": "target-horizon", "horizonDays": days })),
        Method::ProfitPerDay => decision.daily_return_hurdle.map(|hurdle| {
            let mut policy = stored.pricing.profit_per_day_document();
            let object = policy.as_object_mut().expect("an object");
            object.insert("method".into(), json!("profit-per-day"));
            object.insert("dailyReturnHurdle".into(), json!(hurdle));
            policy
        }),
        Method::Percentile => Some(json!({
            "method": "percentile",
            "percentile": decision
                .configured_percentile
                .or(sku.item.percentile_used)
                .unwrap_or(stored.product_lines.default_percentile),
        })),
    }
}

/// A number as JavaScript writes it into JSON: a whole value without a fraction.
fn js_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn object(entries: &[(String, f64)]) -> Value {
    Value::Object(
        entries
            .iter()
            .map(|(k, v)| (k.clone(), js_value(*v)))
            .collect(),
    )
}

/// One product line's share of the batch.
struct Line {
    name: String,
    count: usize,
    percentile_used: f64,
    skipped: bool,
    total_value: f64,
}

fn combined(sku: &PricedSku) -> f64 {
    sku.item.quantity.unwrap_or(0.0) + sku.item.add_to_quantity.unwrap_or(0.0)
}

/// JavaScript's `value || 0`: a missing, zero or NaN value is zero.
fn or_zero(value: Option<f64>) -> f64 {
    value.filter(|v| !v.is_nan()).unwrap_or(0.0)
}

/// The batch's summary document.
#[allow(clippy::too_many_arguments, reason = "buildSummary's inputs, one each")]
pub fn summary(
    batch_number: i32,
    sources: &[PricerSku],
    invalid: usize,
    calculation: &Calculation,
    skus: &[PricedSku],
    names: &HashMap<i64, Display>,
    stored: &StoredConfig,
    processing_ms: u128,
) -> Value {
    let default_percentile = stored.product_lines.default_percentile;
    let mut breakdown: Vec<Line> = Vec::new();
    for sku in skus {
        let line = sku
            .display
            .as_ref()
            .map(|d| d.product_line.clone())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "Unknown".into());
        let percentile = sku
            .item
            .percentile_used
            .filter(|p| *p != 0.0 && !p.is_nan())
            .unwrap_or(default_percentile);
        let value = or_zero(sku.item.suggested_price) * combined(sku);
        let at = match breakdown.iter().position(|l| l.name == line) {
            Some(at) => at,
            None => {
                breakdown.push(Line {
                    name: line,
                    count: 0,
                    percentile_used: percentile,
                    skipped: false,
                    total_value: 0.0,
                });
                breakdown.len() - 1
            }
        };
        breakdown[at].count += 1;
        breakdown[at].total_value += value;
    }
    for (line, setting) in &stored.product_lines.settings {
        if !setting.skip {
            continue;
        }
        let skipped = sources
            .iter()
            .filter(|s| s.product_line_id == i64::from(*line) && !s.bypass_product_line_skips)
            .count();
        if skipped == 0 {
            continue;
        }
        // As Node names it: the first source SKU's product line with a name, of any line.
        let name = sources
            .iter()
            .filter_map(|s| names.get(&s.sku).map(|d| d.product_line.clone()))
            .find(|l| !l.is_empty())
            .unwrap_or_else(|| format!("ProductLine-{line}"));
        let entry = Line {
            name,
            count: skipped,
            percentile_used: 0.0,
            skipped: true,
            total_value: 0.0,
        };
        match breakdown.iter_mut().find(|l| l.name == entry.name) {
            Some(existing) => *existing = entry,
            None => breakdown.push(entry),
        }
    }

    let stats = &calculation.stats;
    let total = sources.len() + invalid;
    let sum = |value: &dyn Fn(&PricedSku) -> f64| skus.iter().map(value).sum::<f64>();
    let market = |s: &PricedSku| or_zero(s.tcg_market_price);
    let aggregated: &Aggregated = &calculation.aggregated_percentiles;
    let mut summary = json!({
        "totalRows": total,
        "processedRows": stats.processed,
        "skippedRows": invalid + stats.skipped,
        "errorRows": stats.errors,
        "warningRows": stats.warnings,
        "successRate": js_value(if total > 0 { stats.processed as f64 / total as f64 * 100.0 } else { 0.0 }),
        "processingTime": processing_ms,
        "fileName": format!("inventory-batch-{batch_number}"),
        "percentileUsed": js_value(default_percentile),
        "totalQuantity": js_value(sum(&|s| or_zero(s.item.quantity))),
        "totalAddQuantity": js_value(sum(&|s| or_zero(s.item.add_to_quantity))),
        "totals": {
            "marketPrice": js_value(sum(&|s| market(s) * combined(s))),
            "lowPrice": js_value(sum(&|s| or_zero(s.lowest_sale_price) * combined(s))),
            "marketplacePrice": js_value(sum(&|s| or_zero(s.item.price) * combined(s))),
            "percentiles": object(&aggregated.market_price),
        },
        "totalsWithMarket": {
            "marketPrice": js_value(sum(&|s| market(s) * combined(s))),
            "percentiles": object(&aggregated.market_price),
            "quantityWithMarket": js_value(sum(&|s| if market(s) != 0.0 { combined(s) } else { 0.0 })),
        },
        "medianDaysToSell": {
            "historicalSalesVelocity": 0,
            "percentiles": object(&aggregated.historical_sales_velocity),
            "marketAdjustedPercentiles": object(&aggregated.estimated_time_to_sell),
        },
    });
    let object = summary.as_object_mut().expect("an object");
    if !breakdown.is_empty() {
        let lines = breakdown.into_iter().map(|l| {
            let entry = json!({
                "count": l.count,
                "percentileUsed": js_value(l.percentile_used),
                "skipped": l.skipped,
                "totalValue": js_value(l.total_value),
            });
            (l.name, entry)
        });
        object.insert(
            "productLineBreakdown".into(),
            Value::Object(lines.collect()),
        );
    }
    if let Some(plan) = &calculation.shadow_portfolio_plan {
        object.insert(
            "shadowPortfolioPlan".into(),
            serde_json::to_value(plan).expect("a plan serializes"),
        );
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::pricing::calculator::PricedItem;

    fn priced(price: Option<f64>, errors: &[&str]) -> PricedSku {
        PricedSku {
            item: PricedItem {
                sku: 42,
                quantity: Some(2.0),
                price,
                suggested_price: Some(1.005),
                percentile_used: Some(65.0),
                historical_sales_velocity_days: Some(18.298494927055042),
                errors: errors.iter().map(|e| e.to_string()).collect(),
                ..PricedItem::default()
            },
            display: Some(Display {
                product_line: "YuGiOh".into(),
                set_name: "Set".into(),
                product_name: "Card - 001 - Common".into(),
                condition: "Near Mint".into(),
                variant: "1st Edition".into(),
            }),
            tcg_market_price: Some(0.28),
            lowest_sale_price: Some(0.11),
            highest_sale_price: Some(0.49),
            sale_count: Some(3.0),
            market_data_at: None,
        }
    }

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().expect("a time")
    }

    #[test]
    fn a_price_without_errors_succeeds() {
        assert_eq!(status(&priced(Some(0.23), &[])), "successful");
        assert_eq!(status(&priced(Some(0.23), &["boom"])), "manual_review");
        assert_eq!(status(&priced(Some(0.0), &[])), "manual_review");
        assert_eq!(status(&priced(None, &[])), "manual_review");
    }

    #[test]
    fn rows_write_numbers_as_javascript_does() {
        let row = row(&priced(Some(0.23), &[]));
        assert_eq!(row["TCGplayer Id"], "42");
        assert_eq!(row["TCG Marketplace Price"], "0.23");
        assert_eq!(
            row["Suggested Price"], "1.00",
            "1.005 sits just under the half in binary"
        );
        assert_eq!(row["Previous Price"], "");
        assert_eq!(row["Total Quantity"], "2");
        assert_eq!(row["Add to Quantity"], "0");
        assert_eq!(row["Sale Count"], "3");
        assert_eq!(row["Percentile Used"], "65");
        assert_eq!(
            row["Historical Sales Velocity (Days)"],
            "18.298494927055042"
        );
        assert_eq!(row["Estimated Time to Sell (Days)"], "");
        assert_eq!(row["Warning"], "");
    }

    #[test]
    fn details_leave_out_what_the_sku_lacks() {
        let details = details(
            &priced(Some(0.23), &[]),
            Mode::Full,
            at("2026-10-04T16:16:19.633Z"),
            &StoredConfig::default(),
        );
        assert_eq!(details["marketDataAt"], "2026-10-04T16:16:19.633Z");
        assert_eq!(details["schemaVersion"], 2);
        assert_eq!(details["pricingModelVersion"], "pooled-supply-v1");
        assert_eq!(details["marketplacePrice"], 0.23);
        assert_eq!(details["tcgMarketPrice"], 0.28);
        assert_eq!(details["warnings"], json!([]));
        assert!(details.get("previousPrice").is_none());
        assert!(details.get("policy").is_none(), "no decision, no policy");
    }

    #[test]
    fn a_sku_repriced_from_its_saved_curve_keeps_the_curve_s_market_reading() {
        let sku = PricedSku {
            lowest_sale_price: None,
            highest_sale_price: Some(0.6),
            sale_count: None,
            market_data_at: Some(at("2026-10-03T08:00:00.120Z")),
            ..priced(Some(0.23), &[])
        };
        let details = details(
            &sku,
            Mode::Cached,
            at("2026-10-04T16:16:19.633Z"),
            &StoredConfig::default(),
        );
        assert_eq!(details["pricedAt"], "2026-10-04T16:16:19.633Z");
        assert_eq!(details["marketDataAt"], "2026-10-03T08:00:00.120Z");
        assert!(details.get("lowestSalePrice").is_none());
        let row = row(&sku);
        assert_eq!(
            (
                row["Sale Count"].as_str(),
                row["Highest Sale Price"].as_str()
            ),
            (Some(""), Some("0.60"))
        );
    }
}
