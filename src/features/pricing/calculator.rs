//! A pricing run over a list of SKUs: each SKU's curve from a resolver, the active policy's
//! decision on it with the price floor, the fallbacks when there is no forecast, and the
//! value-matched shadow plan. Ported from `pricingCalculator.ts` with its tests; the resolver is
//! the part that reads evidence, so a shadow run can feed it the ledgers or a recording.

use std::collections::HashMap;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::buyer_choice_sell_time::{self, Forecast as BuyerChoiceForecast};
use super::condition_normalization::Diagnostics;
use super::condition_sale_rate::{self, RateForecast, SaleRate};
use super::latest_sales_price::Point;
use super::marketplace_price::{self, Floor, Outcome, PriceEvidence, Reference};
use super::policy::{
    self, Basis, Constrained, Constraint, Curve, CurvePoint, Decision, ForecastStatus, Method,
    PercentileDetail, Policy, PortfolioItem, PortfolioPlan, ProfitPerDay,
};
pub use super::sku_price::Failure;
use super::sku_price::Priced;
use crate::features::{
    configuration::config::{Config as StoredConfig, Policy as StoredPolicy},
    inventory_economics::ledger::assumptions::{js_round, js_to_fixed},
    shipping_thresholds::{ShippingCostModel, SnapPolicy},
};

const MILLISECONDS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// The floor every run uses unless its config says otherwise.
pub const DEFAULT_FLOOR: Floor = Floor {
    min_price_multiplier: 80.0 / 85.0,
    min_price_constant: 0.1,
};

/// `Math.round((value + Number.EPSILON) * 100) / 100`.
fn round_currency(value: f64) -> f64 {
    js_round((value + f64::EPSILON) * 100.0) as f64 / 100.0
}

/// `pricingCalculatorConfig`: the run's settings from the stored configuration. Threshold snaps
/// join the profit-per-day policy when they are on, have thresholds and a cost model was learned.
pub fn config_of(
    stored: &StoredConfig,
    excluded_seller_key: Option<String>,
    cost_model: Option<ShippingCostModel>,
) -> Config {
    let policy = match stored.pricing.policy {
        StoredPolicy::Percentile => None,
        StoredPolicy::TargetHorizon(horizon_days) => Some(Policy::TargetHorizon { horizon_days }),
        StoredPolicy::ProfitPerDay => {
            let p = &stored.pricing.profit_per_day;
            let snaps = &stored.snaps;
            let shipping_threshold_snap = cost_model
                .filter(|_| snaps.enabled && !snaps.thresholds.is_empty())
                .map(|cost_model| SnapPolicy {
                    thresholds: snaps.thresholds.iter().map(|t| f64::from(*t)).collect(),
                    snap_range: snaps.snap_range,
                    cost_model,
                });
            Some(Policy::ProfitPerDay(ProfitPerDay {
                daily_return_hurdle: p.daily_return_hurdle,
                relative_overhead: p.relative_overhead,
                static_overhead_per_unit: p.static_overhead_per_unit,
                shipping_threshold_snap,
            }))
        }
    };
    Config {
        percentile: stored.product_lines.default_percentile,
        policy,
        product_lines: Some(ProductLines {
            default_percentile: stored.product_lines.default_percentile,
            settings: stored
                .product_lines
                .settings
                .iter()
                .map(|(line, s)| {
                    (
                        i64::from(*line),
                        ProductLineSetting {
                            percentile: s.percentile,
                            skip: s.skip,
                            daily_return_hurdle: s.daily_return_hurdle,
                        },
                    )
                })
                .collect(),
        }),
        floor: Floor {
            min_price_multiplier: stored.pricing.min_price_multiplier,
            min_price_constant: stored.pricing.min_price_constant,
        },
        supply_analysis: stored.supply.enabled,
        excluded_seller_key,
    }
}

/// A SKU to price.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PricerSku {
    pub sku: i64,
    pub quantity: Option<f64>,
    pub add_to_quantity: Option<f64>,
    pub current_price: Option<f64>,
    pub product_line_id: i64,
    /// Queued from live pending inventory: priced even where its product line is skipped.
    pub bypass_product_line_skips: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProductLineSetting {
    pub percentile: f64,
    pub skip: bool,
    pub daily_return_hurdle: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProductLines {
    pub default_percentile: f64,
    pub settings: HashMap<i64, ProductLineSetting>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub percentile: f64,
    /// None prices by percentile.
    pub policy: Option<Policy>,
    pub product_lines: Option<ProductLines>,
    pub floor: Floor,
    pub supply_analysis: bool,
    pub excluded_seller_key: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            percentile: 65.0,
            policy: None,
            product_lines: None,
            floor: DEFAULT_FLOOR,
            supply_analysis: false,
            excluded_seller_key: None,
        }
    }
}

/// What the resolver is asked for one SKU.
#[derive(Clone, Debug, PartialEq)]
pub struct Request<'a> {
    pub sku: i64,
    pub product_line_id: i64,
    pub percentile: f64,
    pub additional_percentiles: &'a [f64],
    pub supply_analysis: bool,
    pub excluded_seller_key: Option<&'a str>,
}

/// The resolver's answer for one SKU (`SuggestedPriceResult`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Resolved {
    pub error: Option<String>,
    pub suggested_price: Option<f64>,
    pub lowest_listing_price: Option<f64>,
    pub historical_sales_velocity_ms: Option<f64>,
    pub estimated_time_to_sell_ms: Option<f64>,
    pub sales_count: Option<f64>,
    pub listings_count: Option<f64>,
    /// The curve, in days as pricing details store it.
    pub percentiles: Option<Vec<PercentileDetail>>,
    pub condition_sale_rate: Option<SaleRate>,
    pub condition_normalization: Option<Diagnostics>,
    pub price_evidence: Option<PriceEvidence>,
}

/// Milliseconds as days, for a value JavaScript reads as truthy.
fn days(ms: Option<f64>) -> Option<f64> {
    ms.filter(|ms| *ms != 0.0 && !ms.is_nan())
        .map(|ms| ms / MILLISECONDS_PER_DAY)
}

impl From<&Point> for PercentileDetail {
    fn from(point: &Point) -> Self {
        PercentileDetail {
            percentile: point.percentile,
            suggested_price: point.price,
            historical_sales_velocity_days: days(point.historical_sales_velocity_ms),
            estimated_time_to_sell_days: days(point.estimated_time_to_sell_ms),
            sales_count: Some(point.sales_count as f64),
            history_capped: Some(point.history_capped),
            listings_count: point.listings_count.map(|n| n as f64),
            store_win_share: point.store_win_share,
            supply_status: Some(point.supply_status),
        }
    }
}

impl From<Priced> for Resolved {
    fn from(priced: Priced) -> Self {
        Resolved {
            error: None,
            suggested_price: priced.suggested_price,
            lowest_listing_price: priced.lowest_listing_price,
            historical_sales_velocity_ms: priced.historical_sales_velocity_ms,
            estimated_time_to_sell_ms: priced.estimated_time_to_sell_ms,
            sales_count: priced.sales_count.map(|n| n as f64),
            listings_count: priced.listings_count.map(|n| n as f64),
            percentiles: Some(
                priced
                    .percentiles
                    .iter()
                    .map(PercentileDetail::from)
                    .collect(),
            ),
            condition_sale_rate: priced.condition_sale_rate,
            condition_normalization: priced.condition_normalization,
            price_evidence: priced.price_evidence,
        }
    }
}

/// Prices one SKU from its evidence.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Resolve {
    async fn resolve(&self, request: &Request<'_>) -> Result<Resolved, Failure>;
}

/// One priced SKU (`PricingResult`), as a run records it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricedItem {
    pub sku: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_to_quantity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub historical_sales_velocity_days: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_time_to_sell_days: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sales_count_for_historical: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listings_count_for_estimated: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percentile_used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percentiles: Option<Vec<PercentileDetail>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_line_id: Option<i64>,
    pub errors: Vec<String>,
    /// None on a SKU whose resolver failed, as the Node app writes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_decision: Option<Decision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer_choice_forecast: Option<BuyerChoiceForecast>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_rate_forecast: Option<RateForecast>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_normalization: Option<Diagnostics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_evidence: Option<PriceEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_pricing_decision: Option<Decision>,
}

impl PricedItem {
    fn warnings(&mut self) -> &mut Vec<String> {
        self.warnings.get_or_insert_with(Vec::new)
    }

    fn has_warnings(&self) -> bool {
        self.warnings.as_ref().is_some_and(|w| !w.is_empty())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub processed: usize,
    pub skipped: usize,
    pub errors: usize,
    pub warnings: usize,
    pub processing_time: u128,
}

/// Per percentile, keyed `65th` in the Node app's key order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Aggregated {
    /// Quantity-weighted value of the batch at the percentile.
    pub market_price: Vec<(String, f64)>,
    /// Median days between buyers.
    pub historical_sales_velocity: Vec<(String, f64)>,
    /// Median days to sell against competing asks.
    pub estimated_time_to_sell: Vec<(String, f64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Calculation {
    pub priced_items: Vec<PricedItem>,
    pub shadow_portfolio_plan: Option<PortfolioPlan>,
    pub stats: Stats,
    pub aggregated_percentiles: Aggregated,
}

/// The listed price for a candidate under the floor, and whether the floor set it.
fn constrain(
    candidate: f64,
    market: Option<f64>,
    floor: Floor,
    evidence: PriceEvidence,
) -> Constrained {
    let (price, outcome) = marketplace_price::marketplace_price(candidate, market, floor, evidence);
    Constrained {
        price: round_currency(price),
        constraint: if outcome == Outcome::Floored {
            Constraint::Floor
        } else {
            Constraint::Unconstrained
        },
    }
}

fn policy_name(policy: &Policy) -> &'static str {
    if policy.method() == Method::TargetHorizon {
        "Target-horizon"
    } else {
        "Profit-per-day"
    }
}

/// A decision priced from a reference or the current price instead of the curve.
fn fallback_decision(method: Method, reference: &Reference) -> Decision {
    let constraint = if reference.basis == Basis::CurrentPrice {
        Constraint::CurrentPrice
    } else {
        Constraint::Unconstrained
    };
    let mut decision = Decision::new(
        method,
        reference.price,
        constraint,
        reference.basis,
        ForecastStatus::Unavailable,
    );
    decision.unconstrained_price = Some(reference.price);
    decision
}

/// The decision under the policy's name and settings, its forecast unavailable.
fn under_policy(mut decision: Decision, policy: &Policy) -> Decision {
    decision.method = policy.method();
    decision.forecast_status = ForecastStatus::Unavailable;
    decision.with_policy(policy)
}

#[derive(Clone, Copy)]
struct References {
    market_price: Option<f64>,
    lowest_listing_price: Option<f64>,
    current_price: Option<f64>,
}

impl References {
    fn fallback(self) -> Option<Reference> {
        marketplace_price::insufficient_sales_fallback(
            self.market_price,
            self.lowest_listing_price,
            self.current_price,
        )
    }
}

/// When the policy's forecast is unavailable, price as the percentile policy would: the
/// percentile's modeled price, else the best reference, else the current price, with the forecast
/// left unavailable so the price is reviewed.
fn forecast_fallback(
    policy: &Policy,
    percentile_decision: Option<&Decision>,
    references: References,
) -> Option<(Decision, String)> {
    let unavailable = format!("{} forecast unavailable.", policy_name(policy));
    if let Some(decision) = percentile_decision.filter(|d| d.basis == Basis::Modeled) {
        let unprofitable = matches!(policy, Policy::ProfitPerDay(p)
            if policy::net_proceeds_at_price(decision.selected_price, p) <= 0.0);
        let configured = decision
            .configured_percentile
            .map_or_else(|| "undefined".to_string(), |p| p.to_string());
        let mut under = under_policy(decision.clone(), policy);
        if unprofitable {
            under.unprofitable = Some(true);
        }
        return Some((
            under,
            format!("{unavailable} Priced at percentile {configured} instead."),
        ));
    }
    let reference = references.fallback()?;
    Some((
        under_policy(fallback_decision(policy.method(), &reference), policy),
        format!("{unavailable} {}", reference.warning),
    ))
}

/// `productLinePricingPolicy`: a product line's own hurdle for profit per day.
fn product_line_policy(policy: &Policy, setting: Option<&ProductLineSetting>) -> Policy {
    match (policy, setting.and_then(|s| s.daily_return_hurdle)) {
        (Policy::ProfitPerDay(p), Some(hurdle)) => {
            let mut p = p.clone();
            p.daily_return_hurdle = hurdle;
            Policy::ProfitPerDay(p)
        }
        _ => policy.clone(),
    }
}

/// Every percentile a run asks for: the configured one and each product line's.
fn batch_percentiles(config: &Config) -> Vec<f64> {
    let mut percentiles = vec![config.percentile];
    if let Some(lines) = &config.product_lines {
        percentiles.push(lines.default_percentile);
        percentiles.extend(
            lines
                .settings
                .values()
                .filter(|s| !s.skip)
                .map(|s| s.percentile),
        );
    }
    percentiles.sort_by(f64::total_cmp);
    percentiles.dedup();
    percentiles
}

/// `createPricedItem`: the suggestion under the floor, or the insufficient-sales fallback.
fn priced_item(
    sku: &PricerSku,
    result: &Resolved,
    market: Option<f64>,
    floor: Floor,
) -> PricedItem {
    let mut item = PricedItem {
        sku: sku.sku,
        quantity: sku.quantity,
        add_to_quantity: sku.add_to_quantity,
        previous_price: sku.current_price,
        warnings: Some(Vec::new()),
        ..PricedItem::default()
    };
    if let Some(error) = result.error.as_ref().filter(|e| !e.is_empty()) {
        item.errors.push(error.clone());
        return item;
    }
    if let Some(suggested) = result.suggested_price {
        item.suggested_price = Some(suggested);
        let (price, outcome) = marketplace_price::marketplace_price(
            suggested,
            market,
            floor,
            result.price_evidence.unwrap_or_default(),
        );
        item.price = Some(round_currency(price));
        if outcome != Outcome::Suggested {
            item.warnings().push(outcome.warning().to_string());
        }
    } else if let Some(reference) = (References {
        market_price: market,
        lowest_listing_price: result.lowest_listing_price,
        current_price: sku.current_price,
    })
    .fallback()
    {
        item.suggested_price = Some(reference.price);
        item.price = Some(reference.price);
        item.pricing_decision = Some(fallback_decision(Method::Percentile, &reference));
        item.warnings().push(reference.warning);
    }
    item.historical_sales_velocity_days = days(result.historical_sales_velocity_ms);
    item.estimated_time_to_sell_days = days(result.estimated_time_to_sell_ms);
    item.sales_count_for_historical = result.sales_count;
    item.listings_count_for_estimated = result.listings_count;
    item
}

struct PercentileSample {
    percentile: f64,
    price: f64,
    historical_days: Option<f64>,
    estimated_days: Option<f64>,
    quantity: f64,
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    })
}

/// A JavaScript object's key order: whole-number keys ascending, then the rest as first seen.
fn object_key_order(samples: &[PercentileSample]) -> Vec<f64> {
    let mut seen: Vec<f64> = Vec::new();
    for sample in samples {
        if !seen.contains(&sample.percentile) {
            seen.push(sample.percentile);
        }
    }
    let is_index = |p: &f64| p.fract() == 0.0 && *p >= 0.0;
    let mut indexes: Vec<f64> = seen.iter().copied().filter(is_index).collect();
    indexes.sort_by(f64::total_cmp);
    indexes.extend(seen.iter().copied().filter(|p| !is_index(p)));
    indexes
}

fn aggregate(samples: &[PercentileSample]) -> Aggregated {
    let mut aggregated = Aggregated::default();
    for percentile in object_key_order(samples) {
        let key = format!("{percentile}th");
        let group: Vec<&PercentileSample> = samples
            .iter()
            .filter(|s| s.percentile == percentile)
            .collect();
        let quantity = |s: &PercentileSample| {
            if s.quantity == 0.0 || s.quantity.is_nan() {
                1.0
            } else {
                s.quantity
            }
        };
        let total_value = group.iter().fold(0.0, |sum, s| sum + s.price * quantity(s));
        aggregated.market_price.push((key.clone(), total_value));
        if let Some(m) = median(group.iter().filter_map(|s| s.historical_days).collect()) {
            aggregated.historical_sales_velocity.push((key.clone(), m));
        }
        if let Some(m) = median(group.iter().filter_map(|s| s.estimated_days).collect()) {
            aggregated.estimated_time_to_sell.push((key, m));
        }
    }
    aggregated
}

/// Why a run stopped before pricing every SKU.
#[derive(Clone, Debug, PartialEq)]
pub enum Stopped {
    /// The session no longer sees full sales history; the run can be tried again once it does.
    SalesHistoryUnavailable(String),
    Failed(String),
}

impl From<String> for Stopped {
    fn from(message: String) -> Self {
        Stopped::Failed(message)
    }
}

impl From<&str> for Stopped {
    fn from(message: &str) -> Self {
        Stopped::Failed(message.to_owned())
    }
}

impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Stopped::SalesHistoryUnavailable(message) | Stopped::Failed(message) => {
                f.write_str(message)
            }
        }
    }
}

/// How far a run got (`onProgress`): before the first SKU (`current` 0, no `sku`), before each
/// SKU, and when every SKU is done (`current` = `total`, no `sku`), with the counts so far.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tick {
    pub current: usize,
    pub total: usize,
    pub sku: Option<i64>,
    pub stats: Stats,
}

/// `calculatePrices` as of `now`, the shadow plan's cohort named by `source`, each step told to
/// `tick`. Stops only when the resolver reports that sales history is unavailable, or the SKUs
/// repeat.
pub async fn calculate(
    skus: &[PricerSku],
    config: &Config,
    market_prices: &HashMap<i64, f64>,
    source: &str,
    resolver: &impl Resolve,
    now: DateTime<Utc>,
    tick: &mut impl FnMut(Tick),
) -> Result<Calculation, Stopped> {
    let started = Instant::now();
    let mut stats = Stats::default();
    let mut priced_items: Vec<PricedItem> = Vec::new();
    let mut samples: Vec<PercentileSample> = Vec::new();
    let batch = batch_percentiles(config);
    let total = skus.len();
    tick(Tick {
        current: 0,
        total,
        sku: None,
        stats,
    });

    for (index, sku) in skus.iter().enumerate() {
        tick(Tick {
            current: index + 1,
            total,
            sku: Some(sku.sku),
            stats,
        });
        if sku.sku <= 0 {
            stats.skipped += 1;
            continue;
        }
        let setting = config
            .product_lines
            .as_ref()
            .and_then(|lines| lines.settings.get(&sku.product_line_id));
        // Inventory Manager batches bypass skip rules: the user queued them from live inventory.
        if setting.is_some_and(|s| s.skip) && !sku.bypass_product_line_skips {
            stats.skipped += 1;
            continue;
        }
        let effective_percentile = match (&config.product_lines, setting) {
            (None, _) => config.percentile,
            (Some(_), Some(s)) if !s.skip => s.percentile,
            (Some(lines), _) => lines.default_percentile,
        };
        let additional: Vec<f64> = batch
            .iter()
            .copied()
            .filter(|p| *p != effective_percentile)
            .collect();
        let request = Request {
            sku: sku.sku,
            product_line_id: sku.product_line_id,
            percentile: effective_percentile,
            additional_percentiles: &additional,
            supply_analysis: config.supply_analysis,
            excluded_seller_key: config.excluded_seller_key.as_deref(),
        };
        let result = match resolver.resolve(&request).await {
            Ok(result) => result,
            Err(Failure::SalesHistoryUnavailable(message)) => {
                return Err(Stopped::SalesHistoryUnavailable(message));
            }
            Err(Failure::Sku(message)) => {
                priced_items.push(PricedItem {
                    sku: sku.sku,
                    quantity: sku.quantity,
                    add_to_quantity: sku.add_to_quantity,
                    previous_price: sku.current_price,
                    errors: vec![if message.is_empty() {
                        "Processing error".into()
                    } else {
                        message
                    }],
                    warnings: None,
                    ..PricedItem::default()
                });
                stats.errors += 1;
                continue;
            }
        };

        let market = market_prices.get(&sku.sku).copied();
        let mut item = priced_item(sku, &result, market, config.floor);
        item.percentile_used = Some(effective_percentile);
        item.product_line_id = Some(sku.product_line_id);
        item.condition_normalization = result.condition_normalization.clone();
        item.price_evidence = result.price_evidence;
        item.percentiles = result.percentiles.clone();

        let percentile_policy = Policy::Percentile {
            percentile: effective_percentile,
        };
        let active = match &config.policy {
            Some(policy) if policy.method() != Method::Percentile => {
                product_line_policy(policy, setting)
            }
            _ => percentile_policy.clone(),
        };
        let non_percentile = active.method() != Method::Percentile;
        let curve = Curve::new(policy::to_pricing_curve(
            item.percentiles.as_deref().unwrap_or_default(),
        ));
        let references = References {
            market_price: market,
            lowest_listing_price: result.lowest_listing_price,
            current_price: sku.current_price,
        };
        // A curve with no point within a year holds the current price under every policy, or a
        // reference price when the SKU has none.
        let held = if curve.forecasts_within_year() {
            None
        } else {
            marketplace_price::insufficient_sales_fallback(None, None, sku.current_price)
                .or_else(|| references.fallback())
        };
        let hopeless = held.is_some();
        if let Some(held) = &held {
            item.suggested_price = Some(held.price);
            item.price = Some(held.price);
            item.pricing_decision = Some(fallback_decision(Method::Percentile, held));
            let warning = if held.basis == Basis::CurrentPrice {
                format!(
                    "No forecast within a year. Keeping the current price at ${}.",
                    js_to_fixed(held.price, 2)
                )
            } else {
                format!("No forecast within a year. {}", held.warning)
            };
            item.warnings().push(warning);
        }

        let evidence = result.price_evidence.unwrap_or_default();
        let floor = config.floor;
        let apply = move |candidate: f64| constrain(candidate, market, floor, evidence);
        let forecast_decision = if hopeless {
            None
        } else {
            policy::select_decision(&curve, &active, sku.current_price, Some(&apply))
        };
        if non_percentile && !hopeless {
            item.shadow_pricing_decision = policy::select_decision(
                &curve,
                &percentile_policy,
                sku.current_price,
                Some(&apply),
            )
            .or_else(|| item.pricing_decision.clone());
        }
        let fallback = if non_percentile
            && !hopeless
            && forecast_decision.as_ref().map(|d| d.basis) != Some(Basis::Modeled)
        {
            forecast_fallback(&active, item.shadow_pricing_decision.as_ref(), references)
        } else {
            None
        };
        let active_decision = fallback
            .as_ref()
            .map(|(d, _)| d.clone())
            .or(forecast_decision);

        if non_percentile
            && let Some(decision) = &active_decision
            && item.errors.is_empty()
        {
            let suggested = decision
                .unconstrained_price
                .unwrap_or(decision.selected_price);
            item.suggested_price = Some(suggested);
            item.price = Some(decision.selected_price);
            let mut warnings = Vec::new();
            if let Some((_, warning)) = &fallback {
                warnings.push(warning.clone());
            }
            if decision.unprofitable == Some(true) {
                warnings.push(format!(
                    "No modeled price clears per-unit overhead. Listed at ${} to limit the loss.",
                    js_to_fixed(decision.selected_price, 2)
                ));
            }
            if decision.basis == Basis::Modeled {
                let (_, outcome) =
                    marketplace_price::marketplace_price(suggested, market, floor, evidence);
                if outcome != Outcome::Suggested {
                    warnings.push(outcome.warning().to_string());
                }
            }
            item.warnings = Some(warnings);
        }

        match &active_decision {
            Some(decision) if decision.basis == Basis::Modeled => {
                item.pricing_decision = Some(decision.clone());
                item.historical_sales_velocity_days = decision.buyer_interval_days;
                item.estimated_time_to_sell_days = decision.estimated_median_sell_days;
                item.sales_count_for_historical =
                    decision.qualifying_sales_count.map(|n| js_round(n) as f64);
                item.listings_count_for_estimated =
                    decision.listings_count.map(|n| js_round(n) as f64);
                item.buyer_choice_forecast = buyer_choice_sell_time::forecast(
                    curve.points(),
                    decision.selected_price,
                    buyer_choice_sell_time::CALIBRATION,
                );
                item.condition_rate_forecast = condition_sale_rate::forecast(
                    result.condition_sale_rate.as_ref(),
                    decision.store_win_share,
                );
            }
            Some(decision) if non_percentile => item.pricing_decision = Some(decision.clone()),
            _ => match item.pricing_decision.take() {
                Some(mut existing) if non_percentile => {
                    existing.method = active.method();
                    existing.configured_percentile = None;
                    item.pricing_decision = Some(existing.with_policy(&active));
                }
                Some(mut existing) => {
                    existing.configured_percentile = Some(effective_percentile);
                    item.pricing_decision = Some(existing);
                }
                None => {
                    if let (Some(suggested), Some(price)) = (item.suggested_price, item.price) {
                        let constraint = if (price - suggested).abs() >= 0.005 {
                            Constraint::Floor
                        } else {
                            Constraint::Unconstrained
                        };
                        let mut decision = Decision::new(
                            Method::Percentile,
                            round_currency(price),
                            constraint,
                            Basis::Modeled,
                            ForecastStatus::Unavailable,
                        );
                        decision.unconstrained_price = Some(round_currency(suggested));
                        decision.configured_percentile = Some(effective_percentile);
                        item.pricing_decision = Some(decision);
                    }
                }
            },
        }

        if !item.errors.is_empty() {
            stats.errors += 1;
        } else if item.has_warnings() {
            stats.warnings += 1;
            stats.processed += 1;
        } else {
            stats.processed += 1;
        }

        let quantity = sku.quantity.unwrap_or(0.0) + sku.add_to_quantity.unwrap_or(0.0);
        for point in result.percentiles.iter().flatten() {
            samples.push(PercentileSample {
                percentile: point.percentile,
                price: point.suggested_price,
                historical_days: point.historical_sales_velocity_days,
                estimated_days: point.estimated_time_to_sell_days,
                quantity,
            });
        }
        priced_items.push(item);
    }
    tick(Tick {
        current: total,
        total,
        sku: None,
        stats,
    });

    stats.processing_time = started.elapsed().as_millis();
    let aggregated_percentiles = aggregate(&samples);

    let source_skus: HashMap<i64, &PricerSku> = skus.iter().map(|s| (s.sku, s)).collect();
    let current = |sku: i64| source_skus.get(&sku).and_then(|s| s.current_price);
    let constraints: Vec<Box<dyn Fn(f64) -> Constrained>> = priced_items
        .iter()
        .map(|item| {
            let market = market_prices.get(&item.sku).copied();
            let evidence = item.price_evidence.unwrap_or_default();
            let floor = config.floor;
            Box::new(move |candidate: f64| constrain(candidate, market, floor, evidence))
                as Box<dyn Fn(f64) -> Constrained>
        })
        .collect();
    let portfolio: Vec<PortfolioItem> = priced_items
        .iter()
        .zip(&constraints)
        .map(|(item, apply)| {
            let curve = Curve::new(policy::to_pricing_curve(
                item.percentiles.as_deref().unwrap_or_default(),
            ));
            let evidence = item.price_evidence.unwrap_or_default();
            let identity = [
                market_prices.get(&item.sku).copied().unwrap_or(0.0),
                config.floor.min_price_multiplier,
                config.floor.min_price_constant,
                evidence.own_condition_low_sale_price.unwrap_or(0.0),
                evidence.second_cheapest_ask_price.unwrap_or(0.0),
            ]
            .map(|n| n.to_string())
            .join(":");
            PortfolioItem {
                sku: item.sku,
                current_price: current(item.sku),
                curve: if curve.forecasts_within_year() {
                    curve
                } else {
                    Curve::new(Vec::<CurvePoint>::new())
                },
                constraint_identity: Some(identity),
                apply_constraint: Some(apply.as_ref()),
            }
        })
        .collect();
    let has_baseline = portfolio
        .iter()
        .any(|item| item.current_price.unwrap_or(0.0) > 0.0);
    let percentile_run = config
        .policy
        .as_ref()
        .is_none_or(|policy| policy.method() == Method::Percentile);
    let shadow = if percentile_run && has_baseline {
        Some(policy::resolve_value_matched_portfolio_plan(
            &portfolio,
            now,
            Some(source),
        )?)
    } else {
        None
    };
    drop(portfolio);

    let shadow_portfolio_plan = shadow.map(|shadow| {
        for item in &mut priced_items {
            item.shadow_pricing_decision = shadow.decisions_by_sku.get(&item.sku).cloned();
        }
        shadow.plan
    });
    Ok(Calculation {
        priced_items,
        shadow_portfolio_plan,
        stats,
        aggregated_percentiles,
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::super::condition_normalization::Method as NormalizationMethod;
    use super::super::policy::{MatchStatus, ProfitPerDay, SupplyStatus};
    use super::*;

    struct Fixed(Resolved);

    impl Resolve for Fixed {
        async fn resolve(&self, _: &Request<'_>) -> Result<Resolved, Failure> {
            Ok(self.0.clone())
        }
    }

    struct Failing {
        failure: Failure,
        calls: Cell<usize>,
    }

    impl Resolve for Failing {
        async fn resolve(&self, _: &Request<'_>) -> Result<Resolved, Failure> {
            self.calls.set(self.calls.get() + 1);
            Err(self.failure.clone())
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-01T00:00:00Z")
            .unwrap()
            .to_utc()
    }

    fn sku(sku: i64, quantity: f64, current_price: f64) -> PricerSku {
        PricerSku {
            sku,
            quantity: Some(quantity),
            current_price: Some(current_price),
            product_line_id: 1,
            ..PricerSku::default()
        }
    }

    fn point(percentile: f64, price: f64) -> PercentileDetail {
        PercentileDetail {
            percentile,
            suggested_price: price,
            ..PercentileDetail::default()
        }
    }

    fn observed(percentile: f64, price: f64, estimated_days: f64) -> PercentileDetail {
        PercentileDetail {
            estimated_time_to_sell_days: Some(estimated_days),
            supply_status: Some(SupplyStatus::Observed),
            ..point(percentile, price)
        }
    }

    fn curve(suggested: f64, percentiles: Vec<PercentileDetail>) -> Resolved {
        Resolved {
            suggested_price: Some(suggested),
            percentiles: Some(percentiles),
            ..Resolved::default()
        }
    }

    async fn run(
        skus: &[PricerSku],
        config: &Config,
        market: &[(i64, f64)],
        resolved: Resolved,
    ) -> Calculation {
        calculate(
            skus,
            config,
            &market.iter().copied().collect(),
            "pricing",
            &Fixed(resolved),
            now(),
            &mut |_| {},
        )
        .await
        .unwrap()
    }

    fn profit_per_day(hurdle: f64, static_overhead: f64) -> Config {
        Config {
            policy: Some(Policy::ProfitPerDay(ProfitPerDay {
                daily_return_hurdle: hurdle,
                relative_overhead: 0.15,
                static_overhead_per_unit: static_overhead,
                shipping_threshold_snap: None,
            })),
            ..Config::default()
        }
    }

    fn two_points() -> Resolved {
        curve(
            14.0,
            vec![observed(5.0, 10.0, 10.0), observed(65.0, 14.0, 30.0)],
        )
    }

    fn sales_only(price: f64) -> Resolved {
        let disabled = |percentile, price| PercentileDetail {
            supply_status: Some(SupplyStatus::Disabled),
            ..point(percentile, price)
        };
        curve(
            price,
            vec![disabled(5.0, price / 2.0), disabled(65.0, price)],
        )
    }

    fn only(calculation: &Calculation) -> &PricedItem {
        &calculation.priced_items[0]
    }

    fn decision(calculation: &Calculation) -> &Decision {
        only(calculation).pricing_decision.as_ref().unwrap()
    }

    fn warnings(calculation: &Calculation) -> Vec<&str> {
        only(calculation)
            .warnings
            .iter()
            .flatten()
            .map(String::as_str)
            .collect()
    }

    #[tokio::test]
    async fn insufficient_sales_fallbacks_are_warning_only_priced_results() {
        let result = run(
            &[sku(123, 1.0, 20.0)],
            &Config::default(),
            &[(123, 10.0)],
            Resolved {
                lowest_listing_price: Some(12.34),
                ..Resolved::default()
            },
        )
        .await;
        assert_eq!(only(&result).price, Some(12.34));
        assert!(only(&result).errors.is_empty());
        assert_eq!(warnings(&result).len(), 1);
        assert_eq!(
            (
                result.stats.processed,
                result.stats.errors,
                result.stats.warnings
            ),
            (1, 0, 1)
        );
        assert_eq!(decision(&result).selected_price, 12.34);
        assert_eq!(decision(&result).basis, Basis::MarketAndListingReference);
        assert_eq!(decision(&result).constraint, Constraint::Unconstrained);
    }

    #[tokio::test]
    async fn a_shadow_horizon_cannot_replace_the_active_percentile_price() {
        let day = |n: f64| Some(n);
        let full = |percentile, price, interval: f64, sales, listings| PercentileDetail {
            historical_sales_velocity_days: day(interval),
            estimated_time_to_sell_days: day(interval),
            sales_count: Some(sales),
            listings_count: Some(listings),
            supply_status: Some(SupplyStatus::Observed),
            ..point(percentile, price)
        };
        let mut resolved = curve(
            14.0,
            vec![
                full(5.0, 10.0, 10.0, 10.0, 0.0),
                full(65.0, 14.0, 30.0, 6.0, 3.0),
                full(95.0, 30.0, 100.0, 2.0, 9.0),
            ],
        );
        resolved.condition_normalization = Some(Diagnostics {
            method: NormalizationMethod::TimeControlledZipf,
            observation_count: 18,
            observed_condition_count: 3,
            condition_exponent: Some(0.4),
            anchor_condition: None,
            condition_time_connected: true,
        });
        let result = run(&[sku(456, 8.0, 20.0)], &Config::default(), &[], resolved).await;
        let item = only(&result);
        assert_eq!(item.suggested_price, Some(14.0));
        assert_eq!(
            item.condition_normalization
                .as_ref()
                .unwrap()
                .condition_exponent,
            Some(0.4),
            "the normalization diagnostics travel with the priced item"
        );
        let forecast = item.buyer_choice_forecast.as_ref().unwrap();
        assert_eq!(
            forecast.calibration,
            buyer_choice_sell_time::CALIBRATION.name
        );
        assert!(forecast.median_sell_days > 0.0);
        assert_eq!(item.price, Some(14.0));
        assert_eq!(decision(&result).method, Method::Percentile);
        let shadow = item.shadow_pricing_decision.as_ref().unwrap();
        assert_eq!(
            (shadow.method, shadow.selected_price),
            (Method::TargetHorizon, 20.0)
        );
        assert_eq!(result.shadow_portfolio_plan.unwrap().baseline_value, 20.0);
    }

    #[tokio::test]
    async fn a_fixed_target_horizon_is_active_with_the_percentile_as_benchmark() {
        let config = Config {
            policy: Some(Policy::TargetHorizon { horizon_days: 20.0 }),
            ..Config::default()
        };
        let result = run(&[sku(457, 1.0, 20.0)], &config, &[], two_points()).await;
        assert_eq!(only(&result).price, Some(12.0));
        assert_eq!(decision(&result).method, Method::TargetHorizon);
        assert_eq!(decision(&result).target_horizon_days, Some(20.0));
        let shadow = only(&result).shadow_pricing_decision.as_ref().unwrap();
        assert_eq!(
            (shadow.method, shadow.selected_price),
            (Method::Percentile, 14.0)
        );
        assert_eq!(result.shadow_portfolio_plan, None);
    }

    #[tokio::test]
    async fn a_target_horizon_falls_back_to_the_percentile_without_a_forecast() {
        let config = Config {
            policy: Some(Policy::TargetHorizon { horizon_days: 20.0 }),
            ..Config::default()
        };
        let unavailable = PercentileDetail {
            estimated_time_to_sell_days: Some(30.0),
            supply_status: Some(SupplyStatus::Unavailable),
            ..point(65.0, 14.0)
        };
        let result = run(
            &[sku(458, 1.0, 20.0)],
            &config,
            &[],
            curve(14.0, vec![unavailable]),
        )
        .await;
        assert_eq!(only(&result).price, Some(14.0));
        let d = decision(&result);
        assert_eq!((d.basis, d.method), (Basis::Modeled, Method::TargetHorizon));
        assert_eq!(d.target_horizon_days, Some(20.0));
        assert_eq!(d.forecast_status, ForecastStatus::Unavailable);
        assert_eq!(
            warnings(&result),
            [
                "Target-horizon forecast unavailable. Priced at percentile 65 instead.",
                "No market price available. Using suggested price directly."
            ]
        );
    }

    #[tokio::test]
    async fn profit_per_day_prices_by_discounted_net_proceeds() {
        let result = run(
            &[sku(459, 1.0, 20.0)],
            &profit_per_day(0.05, 0.3),
            &[],
            two_points(),
        )
        .await;
        assert_eq!(only(&result).price, Some(10.0));
        assert_eq!(decision(&result).method, Method::ProfitPerDay);
        assert_eq!(decision(&result).daily_return_hurdle, Some(0.05));
        let shadow = only(&result).shadow_pricing_decision.as_ref().unwrap();
        assert_eq!(shadow.method, Method::Percentile);
        assert_eq!(result.shadow_portfolio_plan, None);
    }

    #[tokio::test]
    async fn profit_per_day_lists_at_the_least_loss_and_says_so() {
        let result = run(
            &[sku(460, 1.0, 20.0)],
            &profit_per_day(0.005, 20.0),
            &[],
            two_points(),
        )
        .await;
        assert_eq!(only(&result).price, Some(14.0));
        assert_eq!(decision(&result).unprofitable, Some(true));
        assert_eq!(
            warnings(&result)[0],
            "No modeled price clears per-unit overhead. Listed at $14.00 to limit the loss."
        );
    }

    #[tokio::test]
    async fn a_product_line_hurdle_overrides_the_default_hurdle() {
        let config = Config {
            product_lines: Some(ProductLines {
                default_percentile: 65.0,
                settings: HashMap::from([(
                    1,
                    ProductLineSetting {
                        percentile: 65.0,
                        skip: false,
                        daily_return_hurdle: Some(0.05),
                    },
                )]),
            }),
            ..profit_per_day(0.001, 0.3)
        };
        let result = run(&[sku(461, 1.0, 20.0)], &config, &[], two_points()).await;
        assert_eq!(only(&result).price, Some(10.0));
        assert_eq!(decision(&result).daily_return_hurdle, Some(0.05));
    }

    #[tokio::test]
    async fn an_unavailable_forecast_prices_as_the_percentile_policy_would() {
        let config = profit_per_day(0.005, 0.3);
        let disabled = run(
            &[sku(470, 1.0, 20.0)],
            &config,
            &[(470, 9.85)],
            sales_only(14.0),
        )
        .await;
        let d = decision(&disabled);
        assert_eq!(only(&disabled).price, Some(14.0));
        assert_eq!((d.method, d.basis), (Method::ProfitPerDay, Basis::Modeled));
        assert_eq!(d.daily_return_hurdle, Some(0.005));
        assert_eq!(d.forecast_status, ForecastStatus::Unavailable);
        assert_eq!(d.configured_percentile, Some(65.0));
        assert_eq!(d.unprofitable, None);
        assert_eq!(
            warnings(&disabled),
            ["Profit-per-day forecast unavailable. Priced at percentile 65 instead."]
        );

        let losing = run(
            &[sku(473, 1.0, 20.0)],
            &config,
            &[(473, 0.3)],
            sales_only(0.25),
        )
        .await;
        assert_eq!(only(&losing).price, Some(0.25));
        assert_eq!(decision(&losing).unprofitable, Some(true));
        assert_eq!(
            warnings(&losing),
            [
                "Profit-per-day forecast unavailable. Priced at percentile 65 instead.",
                "No modeled price clears per-unit overhead. Listed at $0.25 to limit the loss."
            ]
        );

        let market_only = run(
            &[sku(471, 1.0, 20.0)],
            &config,
            &[(471, 9.85)],
            Resolved::default(),
        )
        .await;
        assert_eq!(only(&market_only).price, Some(9.85));
        let d = decision(&market_only);
        assert_eq!(
            (d.method, d.basis),
            (Method::ProfitPerDay, Basis::MarketReference)
        );
        assert_eq!(d.forecast_status, ForecastStatus::Unavailable);
        assert_eq!(
            warnings(&market_only),
            [
                "Profit-per-day forecast unavailable. Insufficient sales history. Using the highest available reference price (TCG market $9.85): $9.85."
            ]
        );

        let listing_only = Resolved {
            lowest_listing_price: Some(12.34),
            ..Resolved::default()
        };
        let listing = run(&[sku(472, 1.0, 20.0)], &config, &[], listing_only).await;
        assert_eq!(only(&listing).price, Some(12.34));
        assert_eq!(decision(&listing).basis, Basis::ListingReference);

        let nothing = run(&[sku(474, 1.0, 20.0)], &config, &[], Resolved::default()).await;
        assert_eq!(only(&nothing).price, Some(20.0));
        assert_eq!(decision(&nothing).basis, Basis::CurrentPrice);
        assert_eq!(
            warnings(&nothing),
            [
                "Profit-per-day forecast unavailable. Insufficient sales history and no market price or listing is available. Keeping the current price at $20.00."
            ]
        );
    }

    #[tokio::test]
    async fn unavailable_supply_leaves_the_shadow_plan_nothing_modeled() {
        let unavailable = |percentile, price, interval| PercentileDetail {
            historical_sales_velocity_days: Some(interval),
            supply_status: Some(SupplyStatus::Unavailable),
            ..point(percentile, price)
        };
        let resolved = curve(
            14.0,
            vec![unavailable(5.0, 10.0, 10.0), unavailable(95.0, 30.0, 100.0)],
        );
        let result = run(&[sku(789, 1.0, 20.0)], &Config::default(), &[], resolved).await;
        let plan = result.shadow_portfolio_plan.as_ref().unwrap();
        assert_eq!(plan.modeled_sku_count, 0);
        assert_eq!(plan.match_status, MatchStatus::Infeasible);
        assert_eq!(
            only(&result)
                .shadow_pricing_decision
                .as_ref()
                .unwrap()
                .basis,
            Basis::CurrentPrice
        );
    }

    #[tokio::test]
    async fn the_condition_rate_forecast_is_recorded_at_the_listed_price() {
        let at = |percentile, price, interval, listings, share| PercentileDetail {
            historical_sales_velocity_days: Some(interval),
            listings_count: Some(listings),
            store_win_share: Some(share),
            supply_status: Some(SupplyStatus::Observed),
            ..point(percentile, price)
        };
        let mut resolved = curve(
            14.0,
            vec![
                at(5.0, 10.0, 10.0, 0.0, 1.0),
                at(65.0, 14.0, 30.0, 3.0, 0.25),
            ],
        );
        resolved.condition_sale_rate = Some(SaleRate {
            interval_days: 12.0,
            transactions: 30.0,
            method: condition_sale_rate::METHOD,
        });
        let result = run(&[sku(790, 1.0, 20.0)], &Config::default(), &[], resolved).await;
        let rate = only(&result).condition_rate_forecast.as_ref().unwrap();
        assert_eq!(rate.transactions, 30.0);
        assert!((rate.median_sell_days - std::f64::consts::LN_2 * 12.0 / 0.25).abs() < 1e-9);
    }

    #[tokio::test]
    async fn the_price_floor_yields_to_the_skus_own_evidence() {
        let mut resolved = curve(14.0, vec![observed(65.0, 14.0, 10.0)]);
        resolved.price_evidence = Some(PriceEvidence {
            own_condition_low_sale_price: None,
            second_cheapest_ask_price: Some(12.0),
        });
        let result = run(
            &[sku(791, 1.0, 20.0)],
            &Config::default(),
            &[(791, 20.0)],
            resolved,
        )
        .await;
        assert_eq!(
            only(&result).price,
            Some(14.0),
            "the market floor gives way to a cheaper ask"
        );
        assert_eq!(decision(&result).constraint, Constraint::Unconstrained);
        assert_eq!(
            only(&result)
                .price_evidence
                .unwrap()
                .second_cheapest_ask_price,
            Some(12.0)
        );
    }

    #[tokio::test]
    async fn a_hopeless_curve_holds_the_current_price_under_every_policy() {
        let hopeless = curve(
            20.0,
            vec![observed(5.0, 6.0, 400.0), observed(95.0, 25.0, 900.0)],
        );
        for config in [Config::default(), profit_per_day(0.005, 0.0)] {
            let result = run(&[sku(792, 1.0, 24.0)], &config, &[], hopeless.clone()).await;
            assert_eq!(only(&result).price, Some(24.0));
            assert_eq!(decision(&result).basis, Basis::CurrentPrice);
            let method = config
                .policy
                .as_ref()
                .map_or(Method::Percentile, Policy::method);
            assert_eq!(decision(&result).method, method);
            assert!(
                warnings(&result)
                    .iter()
                    .any(|w| w.starts_with("No forecast within a year. Keeping the current price"))
            );
        }
    }

    #[tokio::test]
    async fn a_failing_sku_stays_with_its_sku_and_missing_history_stops_the_run() {
        let skus: Vec<PricerSku> = (1..=3).map(|n| sku(n, 1.0, 5.0)).collect();
        let broke = Failing {
            failure: Failure::Sku("sku broke".into()),
            calls: Cell::new(0),
        };
        let ordinary = calculate(
            &skus,
            &Config::default(),
            &HashMap::new(),
            "pricing",
            &broke,
            now(),
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(ordinary.stats.errors, 3);
        let errors: Vec<&[String]> = ordinary
            .priced_items
            .iter()
            .map(|i| i.errors.as_slice())
            .collect();
        assert_eq!(errors, [["sku broke"], ["sku broke"], ["sku broke"]]);

        let signed_out = Failing {
            failure: Failure::SalesHistoryUnavailable("signed out".into()),
            calls: Cell::new(0),
        };
        let stopped = calculate(
            &skus,
            &Config::default(),
            &HashMap::new(),
            "pricing",
            &signed_out,
            now(),
            &mut |_| {},
        )
        .await;
        assert_eq!(
            stopped,
            Err(Stopped::SalesHistoryUnavailable("signed out".to_string()))
        );
        assert_eq!(
            signed_out.calls.get(),
            1,
            "the run stops at the first SKU without history"
        );
    }

    #[test]
    fn aggregates_follow_javascript_key_order() {
        let sample = |percentile, price| PercentileSample {
            percentile,
            price,
            historical_days: Some(price),
            estimated_days: None,
            quantity: 0.0,
        };
        let aggregated = aggregate(&[
            sample(80.0, 2.0),
            sample(72.5, 1.0),
            sample(5.0, 3.0),
            sample(80.0, 4.0),
        ]);
        let keys: Vec<&str> = aggregated
            .market_price
            .iter()
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(keys, ["5th", "80th", "72.5th"]);
        assert_eq!(aggregated.market_price[1].1, 6.0);
        assert_eq!(aggregated.historical_sales_velocity[1].1, 3.0);
        assert!(aggregated.estimated_time_to_sell.is_empty());
    }
}
