//! The strategy dashboard: for the inventory and each product line, listed value and wait at each
//! percentile with the knee between them, the inventory under each pricing policy, the
//! profit-per-day hurdle sweep, and the value-against-horizon curve. Ported from
//! `inventoryStrategy.ts`.
use std::collections::HashMap;

use chrono::{DateTime, Utc};

use super::{collate, dashboard::*, snapshot::SnapshotItem};
use crate::features::{
    configuration::config::{self, Config},
    inventory_economics::ledger::{
        assumptions::{js_round, js_to_fixed},
        fingerprint::js_float,
        proceeds::iso,
    },
    pricing::{
        horizon_value_curve::{HorizonValueSample, fit, log_spaced_horizons},
        marketplace_price::{Floor, Outcome, marketplace_price},
        policy::{
            self, Basis, Constrained, Constraint, Curve, Decision, ForecastStatus, Method,
            PercentileDetail, PortfolioItem, ProfitPerDay, read_decision, read_shadow_decision,
            to_pricing_curve,
        },
    },
};

const KNEE_SCORE_RANGE_TOLERANCE: f64 = 0.02;
const HORIZON_FIT_SAMPLE_COUNT: usize = 24;
const HORIZON_FIT_HIGH_CONFIDENCE_RESIDUAL: f64 = 0.02;
const HORIZON_FIT_MEDIUM_CONFIDENCE_RESIDUAL: f64 = 0.05;

/// `Math.round((value + Number.EPSILON) * 100) / 100`, as this dashboard rounds.
fn round_currency(value: f64) -> f64 {
    js_round((value + f64::EPSILON) * 100.0) as f64 / 100.0
}

/// Adds a value once, as a JavaScript `Set` keeps it, in the order first seen.
fn insert(set: &mut Vec<f64>, value: f64) {
    if !set.contains(&value) {
        set.push(value);
    }
}

fn ascending(values: &mut [f64]) {
    values.sort_by(|l, r| l.partial_cmp(r).unwrap_or(std::cmp::Ordering::Equal));
}

fn floor(config: &Config) -> Floor {
    Floor {
        min_price_multiplier: config.pricing.min_price_multiplier,
        min_price_constant: config.pricing.min_price_constant,
    }
}

fn constrain(suggested: f64, item: &SnapshotItem, config: &Config) -> Constrained {
    let evidence = item
        .pricing_details
        .as_ref()
        .map(|d| d.price_evidence)
        .unwrap_or_default();
    let (price, outcome) = marketplace_price(suggested, item.market_price, floor(config), evidence);
    Constrained {
        price: round_currency(price),
        constraint: if outcome == Outcome::Floored {
            Constraint::Floor
        } else {
            Constraint::Unconstrained
        },
    }
}

/// The policy a product line prices profit per day under: the seller's, at the line's hurdle.
fn profit_per_day(config: &Config, product_line_id: Option<i64>) -> policy::Policy {
    let ppd = &config.pricing.profit_per_day;
    let line_hurdle = product_line_id
        .and_then(|id| i32::try_from(id).ok())
        .and_then(|id| config.product_lines.settings.get(&id))
        .and_then(|setting| setting.daily_return_hurdle);
    policy::Policy::ProfitPerDay(ProfitPerDay {
        daily_return_hurdle: line_hurdle.unwrap_or(ppd.daily_return_hurdle),
        relative_overhead: ppd.relative_overhead,
        static_overhead_per_unit: ppd.static_overhead_per_unit,
        shipping_threshold_snap: None,
    })
}

fn hurdle_of(policy: &policy::Policy) -> f64 {
    match policy {
        policy::Policy::ProfitPerDay(p) => p.daily_return_hurdle,
        _ => f64::NAN,
    }
}

fn active_method(config: &Config) -> Method {
    match config.pricing.policy {
        config::Policy::Percentile => Method::Percentile,
        config::Policy::TargetHorizon(_) => Method::TargetHorizon,
        config::Policy::ProfitPerDay => Method::ProfitPerDay,
    }
}

fn active_horizon(config: &Config) -> Option<f64> {
    match config.pricing.policy {
        config::Policy::TargetHorizon(days) => Some(days),
        _ => None,
    }
}

fn configured_percentile(product_line_id: i64, config: &Config) -> Option<f64> {
    let setting = i32::try_from(product_line_id)
        .ok()
        .and_then(|id| config.product_lines.settings.get(&id));
    match setting {
        Some(s) if s.skip => None,
        Some(s) => Some(s.percentile),
        None => Some(config.product_lines.default_percentile),
    }
}

/// Each SKU's curve as the pricer holds it, with the floor its price must clear.
struct Portfolio<'a> {
    items: &'a [&'a SnapshotItem],
    constraints: Vec<Box<dyn Fn(f64) -> Constrained + 'a>>,
    curves: Vec<Curve>,
    identities: Vec<String>,
}

impl<'a> Portfolio<'a> {
    fn new(items: &'a [&'a SnapshotItem], config: &'a Config) -> Self {
        let curves = items
            .iter()
            .map(|item| {
                let details = item
                    .pricing_details
                    .as_ref()
                    .filter(|d| {
                        d.persisted.pricing_model_version.as_deref() == Some(policy::MODEL_VERSION)
                    })
                    .and_then(|d| d.persisted.percentiles.as_deref())
                    .unwrap_or_default();
                let curve = Curve::new(to_pricing_curve(details));
                // A curve whose fastest point waits beyond a year is held as no curve.
                if curve.forecasts_within_year() {
                    curve
                } else {
                    Curve::new(Vec::new())
                }
            })
            .collect();
        let identities = items
            .iter()
            .map(|item| {
                let evidence = item
                    .pricing_details
                    .as_ref()
                    .map(|d| d.price_evidence)
                    .unwrap_or_default();
                [
                    item.market_price.unwrap_or(0.0),
                    config.pricing.min_price_multiplier,
                    config.pricing.min_price_constant,
                    evidence.own_condition_low_sale_price.unwrap_or(0.0),
                    evidence.second_cheapest_ask_price.unwrap_or(0.0),
                ]
                .map(js_float)
                .join(":")
            })
            .collect();
        let constraints = items
            .iter()
            .map(|item| {
                Box::new(move |price| constrain(price, item, config))
                    as Box<dyn Fn(f64) -> Constrained + 'a>
            })
            .collect();
        Portfolio {
            items,
            constraints,
            curves,
            identities,
        }
    }

    fn portfolio_items(&self) -> Vec<PortfolioItem<'_>> {
        self.items
            .iter()
            .enumerate()
            .map(|(i, item)| PortfolioItem {
                sku: item.sku,
                current_price: item.current_price,
                curve: self.curves[i].clone(),
                constraint_identity: Some(self.identities[i].clone()),
                apply_constraint: Some(&*self.constraints[i]),
            })
            .collect()
    }
}

/// Decisions by SKU, each item under the policy it gets.
fn decide<'p>(
    items: &[PortfolioItem],
    policy_for: impl Fn(&PortfolioItem) -> &'p policy::Policy,
) -> HashMap<i64, Decision> {
    policy::portfolio_decisions(items, policy_for)
        .into_iter()
        .collect()
}

struct Weighted {
    value: f64,
    weight: f64,
}

fn weighted_quantile(values: &mut [Weighted], quantile: f64) -> f64 {
    values.sort_by(|l, r| {
        l.value
            .partial_cmp(&r.value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let target = values.iter().fold(0.0, |sum, v| sum + v.weight) * quantile;
    let mut cumulative = 0.0;
    for value in values.iter() {
        cumulative += value.weight;
        if cumulative >= target {
            return value.value;
        }
    }
    values.last().map_or(0.0, |v| v.value)
}

fn summarize_time(mut values: Vec<Weighted>) -> Option<TimeDistribution> {
    if values.is_empty() {
        return None;
    }
    Some(TimeDistribution {
        median_days: weighted_quantile(&mut values, 0.5),
        p75_days: weighted_quantile(&mut values, 0.75),
        p90_days: weighted_quantile(&mut values, 0.9),
    })
}

struct ScenarioDetail {
    suggested_price: f64,
    estimated_time_to_sell_days: Option<f64>,
    interpolated: bool,
}

/// `details` are sorted by percentile.
fn scenario_detail(details: &[PercentileDetail], percentile: f64) -> Option<ScenarioDetail> {
    if let Some(exact) = details.iter().find(|d| d.percentile == percentile) {
        return Some(ScenarioDetail {
            suggested_price: exact.suggested_price,
            estimated_time_to_sell_days: exact.estimated_time_to_sell_days,
            interpolated: false,
        });
    }
    let lower = details.iter().rev().find(|d| d.percentile < percentile)?;
    let upper = details.iter().find(|d| d.percentile > percentile)?;
    if lower.percentile == upper.percentile {
        return None;
    }
    let position = (percentile - lower.percentile) / (upper.percentile - lower.percentile);
    let usable = |t: Option<f64>| t.filter(|t| t.is_finite() && *t >= 0.0);
    Some(ScenarioDetail {
        suggested_price: lower.suggested_price
            + (upper.suggested_price - lower.suggested_price) * position,
        estimated_time_to_sell_days: match (
            usable(lower.estimated_time_to_sell_days),
            usable(upper.estimated_time_to_sell_days),
        ) {
            (Some(l), Some(u)) => Some(l + (u - l) * position),
            _ => None,
        },
        interpolated: true,
    })
}

fn build_scenario(
    items: &[(&SnapshotItem, Vec<PercentileDetail>)],
    percentile: f64,
    current_listed_value: f64,
    config: &Config,
) -> Scenario {
    let mut listed_value = current_listed_value;
    let (
        mut modeled_sku_count,
        mut modeled_unit_count,
        mut interpolated_sku_count,
        mut interpolated_unit_count,
    ) = (0, 0, 0, 0);
    let mut time_modeled_unit_count = 0;
    let mut times = Vec::new();
    for (item, details) in items {
        let Some(detail) = scenario_detail(details, percentile) else {
            continue;
        };
        let bounded = constrain(detail.suggested_price, item, config).price;
        let quantity = item.quantity as f64;
        listed_value += bounded * quantity - item.current_price.unwrap_or(0.0) * quantity;
        modeled_sku_count += 1;
        modeled_unit_count += item.quantity;
        if detail.interpolated {
            interpolated_sku_count += 1;
            interpolated_unit_count += item.quantity;
        }
        if let Some(days) = detail
            .estimated_time_to_sell_days
            .filter(|d| d.is_finite() && *d >= 0.0)
        {
            times.push(Weighted {
                value: days,
                weight: quantity,
            });
            time_modeled_unit_count += item.quantity;
        }
    }
    Scenario {
        percentile,
        knee_score: None,
        listed_value: round_currency(listed_value),
        delta_from_current_policy: 0.0,
        delta_percent_from_current_policy: None,
        modeled_sku_count,
        modeled_unit_count,
        interpolated_sku_count,
        interpolated_unit_count,
        time_modeled_unit_count,
        estimated_time: summarize_time(times),
    }
}

/// Value, wait and price movement across one decision per SKU; a SKU without one keeps its price.
fn summarize_decisions(decisions: &[(&SnapshotItem, Option<&Decision>)]) -> DecisionSummary {
    let (mut one_copy_value, mut physical_value) = (0.0, 0.0);
    let (mut modeled_sku_count, mut raised_count, mut lowered_count, mut held_count) = (0, 0, 0, 0);
    let mut times = Vec::new();
    for (item, decision) in decisions {
        let current = item.current_price.unwrap_or(0.0);
        let selected = decision.map_or(current, |d| d.selected_price);
        one_copy_value += selected;
        physical_value += selected * item.quantity as f64;
        let Some(decision) = decision else {
            held_count += 1;
            continue;
        };
        let modeled = decision.basis == Basis::Modeled
            && decision.forecast_status != ForecastStatus::Unavailable;
        if modeled {
            modeled_sku_count += 1;
        }
        if selected > current {
            raised_count += 1;
        } else if selected < current {
            lowered_count += 1;
        } else {
            held_count += 1;
        }
        if let Some(days) = decision.estimated_median_sell_days.filter(|_| modeled) {
            times.push(Weighted {
                value: days,
                weight: item.quantity as f64,
            });
        }
    }
    DecisionSummary {
        one_copy_value: round_currency(one_copy_value),
        physical_value: round_currency(physical_value),
        modeled_sku_count,
        raised_count,
        lowered_count,
        held_count,
        estimated_time: summarize_time(times),
    }
}

fn distinct<T: PartialEq>(
    decisions: &[(&SnapshotItem, Option<&Decision>)],
    pick: impl Fn(&Decision) -> Option<T>,
) -> Vec<T> {
    let mut seen = Vec::new();
    for value in decisions.iter().filter_map(|(_, d)| d.and_then(&pick)) {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

/// The profit-per-day policy at each hurdle of the ladder, plus the line's configured hurdle.
fn hurdle_sweep(
    items: &[&SnapshotItem],
    portfolio: &[PortfolioItem],
    config: &Config,
    configured_hurdle: f64,
) -> Vec<HurdleScenario> {
    let mut hurdles: Vec<f64> = Vec::new();
    for hurdle in HURDLES.into_iter().chain([configured_hurdle]) {
        insert(&mut hurdles, hurdle);
    }
    ascending(&mut hurdles);
    hurdles
        .into_iter()
        .map(|daily_return_hurdle| {
            let policy::Policy::ProfitPerDay(base) = profit_per_day(config, None) else {
                unreachable!()
            };
            let policy = policy::Policy::ProfitPerDay(ProfitPerDay {
                daily_return_hurdle,
                ..base
            });
            let decisions = decide(portfolio, |_| &policy);
            let rows: Vec<_> = items
                .iter()
                .map(|item| (*item, decisions.get(&item.sku)))
                .collect();
            HurdleScenario {
                summary: summarize_decisions(&rows),
                daily_return_hurdle,
                configured: daily_return_hurdle == configured_hurdle,
            }
        })
        .collect()
}

fn policy_comparisons(
    items: &[&SnapshotItem],
    horizon: &HashMap<i64, Decision>,
    profit: &HashMap<i64, Decision>,
    config: &Config,
) -> Vec<PolicyComparison> {
    let method = active_method(config);
    let active_days = active_horizon(config);
    let stored: Vec<(Option<Decision>, Option<Decision>)> = items
        .iter()
        .map(|item| {
            let details = item.pricing_details.as_ref().map(|d| &d.persisted);
            (read_decision(details), read_shadow_decision(details))
        })
        .collect();
    let build = |key: ComparisonKey| -> Option<PolicyComparison> {
        let decisions: Vec<(&SnapshotItem, Option<&Decision>)> = items
            .iter()
            .zip(&stored)
            .map(|(item, (active, benchmark))| {
                let decision = match key {
                    ComparisonKey::Current => None,
                    ComparisonKey::Percentile => active
                        .as_ref()
                        .filter(|d| d.method == Method::Percentile)
                        .or(benchmark
                            .as_ref()
                            .filter(|d| d.method == Method::Percentile)),
                    ComparisonKey::TargetHorizonShadow => match active {
                        Some(d)
                            if active_days.is_some()
                                && d.method == Method::TargetHorizon
                                && d.target_horizon_days == active_days =>
                        {
                            Some(d)
                        }
                        _ => horizon.get(&item.sku),
                    },
                    ComparisonKey::ProfitPerDay => profit.get(&item.sku),
                };
                (*item, decision)
            })
            .collect();
        if key != ComparisonKey::Current && !decisions.iter().any(|(_, d)| d.is_some()) {
            return None;
        }
        let target_horizons = distinct(&decisions, |d| d.target_horizon_days);
        let hurdles = distinct(&decisions, |d| d.daily_return_hurdle);
        let plan_ids = distinct(&decisions, |d| d.plan_id.clone());
        let row_method = match key {
            ComparisonKey::Current => None,
            ComparisonKey::Percentile => Some(Method::Percentile),
            ComparisonKey::TargetHorizonShadow => Some(Method::TargetHorizon),
            ComparisonKey::ProfitPerDay => Some(Method::ProfitPerDay),
        };
        let role = match row_method {
            None => Role::Current,
            Some(m) if m == method => Role::Active,
            Some(_) => Role::Benchmark,
        };
        let label = match key {
            ComparisonKey::Current => "Current listed prices".to_string(),
            ComparisonKey::Percentile => "Configured percentile".into(),
            ComparisonKey::TargetHorizonShadow => {
                format!(
                    "Target horizon ({} days)",
                    active_days.map(|d| js_to_fixed(d, 1)).unwrap_or_default()
                )
            }
            ComparisonKey::ProfitPerDay if hurdles.len() > 1 => {
                "Profit per day at product-line hurdles".into()
            }
            ComparisonKey::ProfitPerDay => format!(
                "Profit per day at {}%/day hurdle",
                hurdles
                    .first()
                    .map_or("NaN".into(), |h| js_to_fixed(h * 100.0, 2))
            ),
        };
        Some(PolicyComparison {
            summary: summarize_decisions(&decisions),
            key,
            label: if role == Role::Benchmark {
                format!("{label} (benchmark)")
            } else {
                label
            },
            role,
            plan_state: if plan_ids.len() > 1 || target_horizons.len() > 1 {
                PlanState::Mixed
            } else if plan_ids.len() == 1 || target_horizons.len() == 1 {
                PlanState::Single
            } else {
                PlanState::None
            },
        })
    };
    [
        ComparisonKey::Current,
        ComparisonKey::Percentile,
        ComparisonKey::TargetHorizonShadow,
        ComparisonKey::ProfitPerDay,
    ]
    .into_iter()
    .filter_map(build)
    .collect()
}

struct Knee {
    mathematical: Option<f64>,
    estimated: Option<f64>,
    range_minimum: Option<f64>,
    range_maximum: Option<f64>,
    confidence: Confidence,
}

const NO_KNEE: Knee = Knee {
    mathematical: None,
    estimated: None,
    range_minimum: None,
    range_maximum: None,
    confidence: Confidence::Unavailable,
};

/// The percentile where listed value gained stops outpacing wait added, both normalized across
/// the scenarios; scores each scored scenario on the way.
fn estimate_knee(
    scenarios: &mut [Scenario],
    configured: Option<f64>,
    total_units: i64,
    exact: &[f64],
) -> Knee {
    let scored: Vec<usize> = (0..scenarios.len())
        .filter(|&i| scenarios[i].estimated_time.is_some() && scenarios[i].modeled_unit_count > 0)
        .collect();
    let candidates: Vec<usize> = scored
        .iter()
        .copied()
        .filter(|&i| exact.contains(&scenarios[i].percentile))
        .collect();
    if candidates.len() < 3 {
        return NO_KNEE;
    }
    let median = |s: &Scenario| s.estimated_time.map_or(0.0, |t| t.median_days);
    let fold = |f: &dyn Fn(&Scenario) -> f64, start: f64, pick: fn(f64, f64) -> f64| {
        scored.iter().map(|&i| f(&scenarios[i])).fold(start, pick)
    };
    let (minimum_value, maximum_value) = (
        fold(&|s| s.listed_value, f64::INFINITY, f64::min),
        fold(&|s| s.listed_value, f64::NEG_INFINITY, f64::max),
    );
    let (minimum_time, maximum_time) = (
        fold(&median, f64::INFINITY, f64::min),
        fold(&median, f64::NEG_INFINITY, f64::max),
    );
    let (value_range, time_range) = (maximum_value - minimum_value, maximum_time - minimum_time);
    if value_range <= 0.0 || time_range <= 0.0 {
        return NO_KNEE;
    }
    for &i in &scored {
        let s = &mut scenarios[i];
        let normalized_time =
            (s.estimated_time.map_or(minimum_time, |t| t.median_days) - minimum_time) / time_range;
        s.knee_score = Some((s.listed_value - minimum_value) / value_range - normalized_time);
    }
    let score = |i: usize| scenarios[i].knee_score.unwrap_or(f64::NEG_INFINITY);
    let mut ranked = candidates.clone();
    ranked.sort_by(|&l, &r| {
        score(r)
            .partial_cmp(&score(l))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                scenarios[l]
                    .percentile
                    .partial_cmp(&scenarios[r].percentile)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let best = &scenarios[ranked[0]];
    let maximum_score = best.knee_score.unwrap_or(0.0);
    let range: Vec<&Scenario> = candidates
        .iter()
        .map(|&i| &scenarios[i])
        .filter(|s| {
            s.knee_score
                .is_some_and(|k| k >= maximum_score - KNEE_SCORE_RANGE_TOLERANCE)
        })
        .collect();
    let configured_candidate = range.iter().find(|s| Some(s.percentile) == configured);
    let coverage = if total_units == 0 {
        0.0
    } else {
        best.modeled_unit_count as f64 / total_units as f64
    };
    Knee {
        mathematical: Some(best.percentile),
        estimated: Some(configured_candidate.map_or(best.percentile, |s| s.percentile)),
        range_minimum: Some(
            range
                .iter()
                .map(|s| s.percentile)
                .fold(f64::INFINITY, f64::min),
        ),
        range_maximum: Some(
            range
                .iter()
                .map(|s| s.percentile)
                .fold(f64::NEG_INFINITY, f64::max),
        ),
        confidence: if coverage < 0.8 {
            Confidence::Low
        } else if range.len() == 1 && candidates.len() >= 5 {
            Confidence::High
        } else {
            Confidence::Medium
        },
    }
}

/// Physical listed value with every modeled SKU priced at one target horizon.
fn horizon_value(items: &[&SnapshotItem], portfolio: &[PortfolioItem], horizon_days: f64) -> f64 {
    let policy = policy::Policy::TargetHorizon { horizon_days };
    let decisions = decide(portfolio, |_| &policy);
    round_currency(items.iter().fold(0.0, |sum, item| {
        let price = decisions
            .get(&item.sku)
            .map(|d| d.selected_price)
            .or(item.current_price)
            .unwrap_or(0.0);
        sum + price * item.quantity as f64
    }))
}

/// Fits the horizon curve from log-spaced samples across the observed horizon range. The range
/// endpoints pin every SKU to its fastest or slowest point, so the first and last samples are the
/// exact floor and ceiling.
fn horizon_model(items: &[&SnapshotItem], portfolio: &[PortfolioItem]) -> Option<HorizonModel> {
    let (minimum_days, maximum_days) = policy::observed_horizon_range(portfolio)?;
    let samples: Vec<HorizonValueSample> =
        log_spaced_horizons(minimum_days, maximum_days, HORIZON_FIT_SAMPLE_COUNT)
            .into_iter()
            .map(|horizon_days| HorizonValueSample {
                horizon_days,
                value: horizon_value(items, portfolio, horizon_days),
            })
            .collect();
    let curve = fit(&samples, samples[0].value, samples[samples.len() - 1].value);
    Some(HorizonModel {
        minimum_horizon_days: minimum_days,
        maximum_horizon_days: maximum_days,
        fit_confidence: match curve {
            None => Confidence::Unavailable,
            Some(c) if c.residual > HORIZON_FIT_MEDIUM_CONFIDENCE_RESIDUAL => Confidence::Low,
            Some(c) if c.residual > HORIZON_FIT_HIGH_CONFIDENCE_RESIDUAL => Confidence::Medium,
            Some(_) => Confidence::High,
        },
        curve,
    })
}

fn build_product_line(
    key: String,
    product_line_id: Option<i64>,
    product_line: String,
    items: &[&SnapshotItem],
    config: &Config,
    additional_percentiles: &[f64],
) -> ProductLine {
    let configured = product_line_id.and_then(|id| configured_percentile(id, config));
    let current_listed_value = round_currency(items.iter().fold(0.0, |sum, i| {
        sum + i.current_price.unwrap_or(0.0) * i.quantity as f64
    }));
    // Listed price stands in for SKUs without a known market price.
    let estimated_market_value = round_currency(items.iter().fold(0.0, |sum, i| {
        sum + i.market_price.or(i.current_price).unwrap_or(0.0) * i.quantity as f64
    }));
    let mut exact = percentiles();
    for item in items {
        for detail in item
            .pricing_details
            .iter()
            .flat_map(|d| d.persisted.percentiles.iter().flatten())
        {
            if detail.percentile.is_finite() && (0.0..=100.0).contains(&detail.percentile) {
                insert(&mut exact, detail.percentile);
            }
        }
    }
    for &percentile in additional_percentiles {
        insert(&mut exact, percentile);
    }
    if let Some(percentile) = configured {
        insert(&mut exact, percentile);
    }
    let in_range = |p: &f64| (MIN_PERCENTILE..=MAX_PERCENTILE).contains(p);
    let mut scenario_percentiles = preview_percentiles();
    for &percentile in exact.iter().filter(|p| in_range(p)) {
        insert(&mut scenario_percentiles, percentile);
    }
    ascending(&mut scenario_percentiles);
    let scenario_items: Vec<(&SnapshotItem, Vec<PercentileDetail>)> = items
        .iter()
        .map(|item| {
            let mut details: Vec<PercentileDetail> = item
                .pricing_details
                .iter()
                .flat_map(|d| d.persisted.percentiles.iter().flatten())
                .filter(|d| {
                    d.percentile.is_finite()
                        && d.suggested_price.is_finite()
                        && d.suggested_price > 0.0
                })
                .cloned()
                .collect();
            details.sort_by(|l, r| {
                l.percentile
                    .partial_cmp(&r.percentile)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            (*item, details)
        })
        .collect();
    let mut scenarios: Vec<Scenario> = scenario_percentiles
        .iter()
        .map(|&p| build_scenario(&scenario_items, p, current_listed_value, config))
        .collect();
    let current_policy_value = scenarios
        .iter()
        .find(|s| Some(s.percentile) == configured)
        .map_or(current_listed_value, |s| s.listed_value);
    set_deltas(&mut scenarios, current_policy_value);

    let modeled: Vec<&&SnapshotItem> = items
        .iter()
        .filter(|i| {
            i.pricing_details
                .as_ref()
                .is_some_and(|d| d.percentile_count > 0)
        })
        .collect();
    let mut pricing_dates: Vec<DateTime<Utc>> = modeled
        .iter()
        .filter_map(|i| i.strategy_priced_at)
        .collect();
    pricing_dates.sort();
    let unit_count: i64 = items.iter().map(|i| i.quantity).sum();
    let knee = estimate_knee(&mut scenarios, configured, unit_count, &exact);
    let portfolio = Portfolio::new(items, config);
    let portfolio_items = portfolio.portfolio_items();
    let configured_hurdle = hurdle_of(&profit_per_day(config, product_line_id));
    let horizon = match active_horizon(config) {
        Some(horizon_days) => {
            let policy = policy::Policy::TargetHorizon { horizon_days };
            decide(&portfolio_items, |_| &policy)
        }
        None => HashMap::new(),
    };
    let line_policies: HashMap<i64, policy::Policy> = items
        .iter()
        .map(|i| (i.sku, profit_per_day(config, Some(i.product_line_id))))
        .collect();
    let profit = decide(&portfolio_items, |item| &line_policies[&item.sku]);
    let mut matrix_percentiles: Vec<f64> = exact.iter().copied().filter(|p| in_range(p)).collect();
    ascending(&mut matrix_percentiles);

    ProductLine {
        key,
        product_line_id,
        product_line,
        configured_percentile: configured,
        pricing_eligible: items.iter().any(|i| i.pricing_eligible),
        sku_count: items.len(),
        unit_count,
        current_listed_value,
        estimated_market_value,
        current_policy_value,
        mathematical_knee_percentile: knee.mathematical,
        estimated_percentile: knee.estimated,
        knee_range_minimum: knee.range_minimum,
        knee_range_maximum: knee.range_maximum,
        knee_confidence: knee.confidence,
        modeled_sku_count: modeled.len(),
        modeled_unit_count: modeled.iter().map(|i| i.quantity).sum(),
        oldest_pricing_at: pricing_dates.first().copied().map(iso),
        newest_pricing_at: pricing_dates.last().copied().map(iso),
        matrix_percentiles,
        scenarios,
        policy_comparisons: policy_comparisons(items, &horizon, &profit, config),
        hurdle_sweep: hurdle_sweep(items, &portfolio_items, config, configured_hurdle),
        horizon_model: horizon_model(items, &portfolio_items),
    }
}

fn set_deltas(scenarios: &mut [Scenario], current_policy_value: f64) {
    for scenario in scenarios {
        scenario.delta_from_current_policy =
            round_currency(scenario.listed_value - current_policy_value);
        scenario.delta_percent_from_current_policy = (current_policy_value != 0.0)
            .then(|| scenario.delta_from_current_policy / current_policy_value * 100.0);
    }
}

/// The dashboard for the seller's in-stock inventory under the stored configuration.
pub fn build(
    seller_key: &str,
    items: &[SnapshotItem],
    config: &Config,
    generated_at: DateTime<Utc>,
) -> Dashboard {
    let mut groups: Vec<(i64, &str, Vec<&SnapshotItem>)> = Vec::new();
    for item in items {
        match groups
            .iter_mut()
            .find(|(id, ..)| *id == item.product_line_id)
        {
            Some((.., rows)) => rows.push(item),
            None => groups.push((item.product_line_id, &item.product_line, vec![item])),
        }
    }
    let mut product_lines: Vec<ProductLine> = groups
        .iter()
        .map(|(id, name, rows)| {
            build_product_line(
                id.to_string(),
                Some(*id),
                name.to_string(),
                rows,
                config,
                &[],
            )
        })
        .collect();
    product_lines.sort_by(|l, r| collate::compare(&l.product_line, &r.product_line));
    let mut additional = vec![config.product_lines.default_percentile];
    additional.extend(
        config
            .product_lines
            .settings
            .values()
            .filter(|s| !s.skip)
            .map(|s| s.percentile),
    );
    let all: Vec<&SnapshotItem> = items.iter().collect();
    let mut overall = build_product_line(
        "all".into(),
        None,
        "All listed inventory".into(),
        &all,
        config,
        &additional,
    );
    overall.current_policy_value = round_currency(
        product_lines
            .iter()
            .fold(0.0, |sum, l| sum + l.current_policy_value),
    );
    set_deltas(&mut overall.scenarios, overall.current_policy_value);
    Dashboard {
        seller_key: seller_key.to_string(),
        generated_at: iso(generated_at),
        policy: config.pricing.policy_document(),
        profit_per_day: config.pricing.profit_per_day_document(),
        overall,
        product_lines,
    }
}

static DASHBOARDS: std::sync::LazyLock<super::cache::VersionedCache<std::sync::Arc<Dashboard>>> =
    std::sync::LazyLock::new(|| super::cache::VersionedCache::new("Inventory strategy dashboard"));

/// The seller's dashboard. A changed pricing configuration waits for a rebuild; changed inventory
/// or curves, which every priced batch brings, serve the last dashboard while the next one builds.
pub async fn load(
    db: &crate::database::Database,
    seller: &str,
    config: &Config,
) -> Result<std::sync::Arc<Dashboard>, String> {
    if seller.is_empty() {
        return Ok(std::sync::Arc::new(build(seller, &[], config, Utc::now())));
    }
    let identity = format!("{}|{config:?}", policy::MODEL_VERSION);
    let version = super::snapshot::find_version(db, seller)
        .await
        .map_err(|e| e.to_string())?;
    let (db, owner, config) = (db.clone(), seller.to_string(), config.clone());
    DASHBOARDS
        .read(seller, &identity, &version, move || async move {
            let items = super::snapshot::find(&db, &owner)
                .await
                .map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || {
                std::sync::Arc::new(build(&owner, &items, &config, Utc::now()))
            })
            .await
            .map_err(|e| e.to_string())
        })
        .await
}
