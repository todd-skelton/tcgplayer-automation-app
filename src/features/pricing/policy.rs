//! How a price is chosen from a SKU's sell-time curve: at a percentile, at a target median sell
//! time, or at the best return on capital; and the shadow plan that matches a portfolio's current
//! value at one horizon. Ported from `pricingPolicy.ts` and `core/types/pricingPolicy.ts`; a
//! decision's JSON keeps the Node app's shape, since both apps store and read it.
use std::{
    collections::{HashMap, HashSet},
    f64::consts::LN_2,
    rc::Rc,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    horizon_value_curve::log_spaced_horizons,
    maximize::maximize_over_candidates,
    shipping_threshold_snap::{self, SnapInputs},
};
use crate::features::{
    inventory_economics::ledger::{
        assumptions::{js_round, js_to_fixed},
        fingerprint::js_json,
        proceeds::iso,
    },
    shipping_thresholds::{ShippingThresholdSnap, SnapOutcome, SnapPolicy},
};

pub const MODEL_VERSION: &str = "pooled-supply-v1";

const BEST_RETURN_SAMPLE_COUNT: usize = 64;
const VALUE_MATCH_SAMPLE_COUNT: usize = 24;
const VALUE_MATCH_REFINEMENTS: usize = 16;
/// A curve whose fastest point waits beyond a year forecasts nothing to trade against.
const HOPELESS_FORECAST_DAYS: f64 = 365.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupplyStatus {
    Observed,
    Unavailable,
    Disabled,
}

/// One point of a SKU's curve: a price, the percentile of recent sales it sits at, and how long
/// it is expected to wait for a buyer there. Fields are in the Node app's order, since a plan's
/// inventory snapshot hashes the curve as written.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurvePoint {
    pub percentile: f64,
    pub price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buyer_interval_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_win_share: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_median_sell_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualifying_sales_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_capped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listings_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supply_status: Option<SupplyStatus>,
}

/// A percentile of the pricer's output, as pricing details store it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PercentileDetail {
    pub percentile: f64,
    pub suggested_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub historical_sales_velocity_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_time_to_sell_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sales_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_capped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listings_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_win_share: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supply_status: Option<SupplyStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitPerDay {
    /// Fraction of capital earned per day when proceeds are redeployed.
    pub daily_return_hurdle: f64,
    /// Overhead as a fraction of sale price.
    pub relative_overhead: f64,
    /// Overhead in dollars per unit sold.
    pub static_overhead_per_unit: f64,
    /// Considers listing just under a shipping threshold when it returns more.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipping_threshold_snap: Option<SnapPolicy>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum Policy {
    Percentile {
        percentile: f64,
    },
    #[serde(rename_all = "camelCase")]
    TargetHorizon {
        horizon_days: f64,
    },
    ProfitPerDay(ProfitPerDay),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    Percentile,
    TargetHorizon,
    ProfitPerDay,
}

impl Policy {
    pub fn method(&self) -> Method {
        match self {
            Policy::Percentile { .. } => Method::Percentile,
            Policy::TargetHorizon { .. } => Method::TargetHorizon,
            Policy::ProfitPerDay(_) => Method::ProfitPerDay,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Constraint {
    #[serde(rename = "none")]
    Unconstrained,
    Floor,
    CurrentPrice,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Basis {
    Modeled,
    MarketReference,
    ListingReference,
    MarketAndListingReference,
    CurrentPrice,
    LegacyUnknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForecastStatus {
    Interpolated,
    LowerBound,
    UpperBound,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchStatus {
    Matched,
    Boundary,
    Infeasible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub method: Method,
    pub selected_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unconstrained_price: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equivalent_percentile: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_percentile: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_horizon_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_return_hurdle: Option<f64>,
    /// Net proceeds at the selected price do not clear per-unit overhead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unprofitable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buyer_interval_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_win_share: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_median_sell_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualifying_sales_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_capped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listings_count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supply_status: Option<SupplyStatus>,
    pub constraint: Constraint,
    /// The shipping threshold snap considered for this price, and whether it was taken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipping_threshold_snap: Option<ShippingThresholdSnap>,
    pub basis: Basis,
    pub forecast_status: ForecastStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_match_status: Option<MatchStatus>,
}

impl Decision {
    fn new(
        method: Method,
        selected_price: f64,
        constraint: Constraint,
        basis: Basis,
        forecast_status: ForecastStatus,
    ) -> Self {
        Decision {
            method,
            selected_price,
            unconstrained_price: None,
            equivalent_percentile: None,
            configured_percentile: None,
            target_horizon_days: None,
            daily_return_hurdle: None,
            unprofitable: None,
            buyer_interval_days: None,
            store_win_share: None,
            estimated_median_sell_days: None,
            qualifying_sales_count: None,
            history_capped: None,
            listings_count: None,
            supply_status: None,
            constraint,
            shipping_threshold_snap: None,
            basis,
            forecast_status,
            plan_id: None,
            plan_match_status: None,
        }
    }

    /// The policy's own setting: its percentile, horizon or hurdle.
    fn with_policy(mut self, policy: &Policy) -> Self {
        match policy {
            Policy::Percentile { percentile } => self.configured_percentile = Some(*percentile),
            Policy::TargetHorizon { horizon_days } => {
                self.target_horizon_days = Some(*horizon_days)
            }
            Policy::ProfitPerDay(p) => self.daily_return_hurdle = Some(p.daily_return_hurdle),
        }
        self
    }

    /// What the curve says at the price: its percentile and forecast.
    fn at_point(mut self, point: &CurvePoint) -> Self {
        self.equivalent_percentile = Some(point.percentile);
        self.buyer_interval_days = point.buyer_interval_days;
        self.store_win_share = point.store_win_share;
        self.estimated_median_sell_days = point.estimated_median_sell_days;
        self.qualifying_sales_count = point.qualifying_sales_count;
        self.history_capped = point.history_capped;
        self.listings_count = point.listings_count;
        self.supply_status = point.supply_status;
        self
    }
}

/// A price after the floor, and whether the floor moved it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Constrained {
    pub price: f64,
    pub constraint: Constraint,
}

pub type ApplyConstraint<'a> = &'a dyn Fn(f64) -> Constrained;

fn round_currency(value: f64) -> f64 {
    js_round(value * 100.0) as f64 / 100.0
}

fn is_positive(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v > 0.0)
}

/// Median wait for a buyer interval when the store wins the given share of buyers.
pub fn median_sell_days(
    buyer_interval_days: Option<f64>,
    store_win_share: Option<f64>,
    fallback: Option<f64>,
) -> Option<f64> {
    match (
        is_positive(buyer_interval_days),
        is_positive(store_win_share),
    ) {
        (Some(interval), Some(share)) => Some((LN_2 * interval) / share),
        _ => fallback,
    }
}

/// The pricer's percentiles as a curve, lowest percentile first, without unpriced points or
/// model inputs that are not positive.
pub fn to_pricing_curve(details: &[PercentileDetail]) -> Vec<CurvePoint> {
    let mut curve: Vec<CurvePoint> = details
        .iter()
        .filter(|d| {
            d.percentile.is_finite() && d.suggested_price.is_finite() && d.suggested_price > 0.0
        })
        .map(|d| {
            let buyer_interval_days = is_positive(d.historical_sales_velocity_days);
            let store_win_share = is_positive(d.store_win_share);
            CurvePoint {
                percentile: d.percentile,
                price: d.suggested_price,
                buyer_interval_days,
                store_win_share,
                estimated_median_sell_days: median_sell_days(
                    buyer_interval_days,
                    store_win_share,
                    d.estimated_time_to_sell_days,
                ),
                qualifying_sales_count: d.sales_count,
                history_capped: d.history_capped,
                listings_count: d.listings_count,
                supply_status: d.supply_status,
            }
        })
        .collect();
    curve.sort_by(|l, r| {
        l.percentile
            .partial_cmp(&r.percentile)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    curve
}

fn mix_optional(left: Option<f64>, right: Option<f64>, ratio: f64) -> Option<f64> {
    if ratio <= 0.0 {
        return left;
    }
    if ratio >= 1.0 {
        return right;
    }
    Some(left? + (right? - left?) * ratio)
}

/// JavaScript's `lower.historyCapped || upper.historyCapped`: the upper's flag unless the lower's
/// is set.
fn mix_flag(left: Option<bool>, right: Option<bool>) -> Option<bool> {
    if left == Some(true) { left } else { right }
}

fn interpolate(lower: &CurvePoint, upper: &CurvePoint, ratio: f64) -> CurvePoint {
    let buyer_interval_days =
        mix_optional(lower.buyer_interval_days, upper.buyer_interval_days, ratio);
    let store_win_share = mix_optional(lower.store_win_share, upper.store_win_share, ratio);
    let interpolated_median = mix_optional(
        lower.estimated_median_sell_days,
        upper.estimated_median_sell_days,
        ratio,
    );
    CurvePoint {
        percentile: (lower.percentile + (upper.percentile - lower.percentile) * ratio)
            .clamp(0.0, 100.0),
        price: round_currency(lower.price + (upper.price - lower.price) * ratio),
        buyer_interval_days,
        store_win_share,
        estimated_median_sell_days: median_sell_days(
            buyer_interval_days,
            store_win_share,
            interpolated_median,
        ),
        qualifying_sales_count: mix_optional(
            lower.qualifying_sales_count,
            upper.qualifying_sales_count,
            ratio,
        ),
        history_capped: mix_flag(lower.history_capped, upper.history_capped),
        listings_count: mix_optional(lower.listings_count, upper.listings_count, ratio),
        supply_status: if lower.supply_status == upper.supply_status {
            lower.supply_status
        } else {
            None
        },
    }
}

fn is_observed_sell_time(point: &CurvePoint) -> bool {
    point.supply_status == Some(SupplyStatus::Observed)
        && is_positive(point.estimated_median_sell_days).is_some()
}

fn median(point: &CurvePoint) -> f64 {
    point.estimated_median_sell_days.unwrap_or(0.0)
}

fn by<T>(key: impl Fn(&T) -> f64) -> impl Fn(&T, &T) -> std::cmp::Ordering {
    move |l, r| {
        key(l)
            .partial_cmp(&key(r))
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}

/// A SKU's curve with the orders it is read in: by percentile, by price, and the points with an
/// observed sell time from fastest to slowest.
#[derive(Clone, Debug, PartialEq)]
pub struct Curve {
    points: Vec<CurvePoint>,
    by_percentile: Vec<CurvePoint>,
    by_price: Vec<CurvePoint>,
    by_sell_time: Vec<CurvePoint>,
}

impl Curve {
    pub fn new(points: Vec<CurvePoint>) -> Curve {
        let mut by_percentile = points.clone();
        by_percentile.sort_by(by(|p: &CurvePoint| p.percentile));
        let mut by_price = points.clone();
        by_price.sort_by(|l, r| {
            by(|p: &CurvePoint| p.price)(l, r).then_with(|| by(|p: &CurvePoint| p.percentile)(l, r))
        });
        let mut by_sell_time: Vec<CurvePoint> = points
            .iter()
            .map(|p| CurvePoint {
                estimated_median_sell_days: median_sell_days(
                    p.buyer_interval_days,
                    p.store_win_share,
                    p.estimated_median_sell_days,
                ),
                ..p.clone()
            })
            .filter(is_observed_sell_time)
            .collect();
        by_sell_time.sort_by(by(median));
        Curve {
            points,
            by_percentile,
            by_price,
            by_sell_time,
        }
    }

    pub fn points(&self) -> &[CurvePoint] {
        &self.points
    }

    fn minimum_price(&self) -> f64 {
        self.by_price.first().map_or(f64::INFINITY, |p| p.price)
    }

    fn maximum_price(&self) -> f64 {
        self.by_price.last().map_or(f64::NEG_INFINITY, |p| p.price)
    }

    /// False when the curve's fastest observed point still waits beyond a year.
    pub fn forecasts_within_year(&self) -> bool {
        self.by_sell_time
            .first()
            .is_none_or(|p| median(p) <= HOPELESS_FORECAST_DAYS)
    }

    fn at_percentile(&self, percentile: f64) -> Option<CurvePoint> {
        let points = &self.by_percentile;
        let (first, last) = (points.first()?, points.last()?);
        if percentile <= first.percentile {
            return Some(first.clone());
        }
        if percentile >= last.percentile {
            return Some(last.clone());
        }
        let upper_index = points.iter().position(|p| p.percentile >= percentile)?;
        let (lower, upper) = (&points[upper_index - 1], &points[upper_index]);
        let span = upper.percentile - lower.percentile;
        Some(interpolate(
            lower,
            upper,
            if span == 0.0 {
                0.0
            } else {
                (percentile - lower.percentile) / span
            },
        ))
    }

    fn at_price(&self, price: f64) -> Option<CurvePoint> {
        let points = &self.by_price;
        let (first, last) = (points.first()?, points.last()?);
        if price <= first.price {
            return Some(first.clone());
        }
        if price >= last.price {
            return Some(last.clone());
        }
        let upper_index = points.iter().position(|p| p.price >= price)?;
        let (lower, upper) = (&points[upper_index - 1], &points[upper_index]);
        let span = upper.price - lower.price;
        Some(interpolate(
            lower,
            upper,
            if span == 0.0 {
                0.0
            } else {
                (price - lower.price) / span
            },
        ))
    }

    fn at_horizon(&self, horizon_days: f64) -> Option<CurvePoint> {
        (!self.by_sell_time.is_empty()).then(|| at_sell_time(&self.by_sell_time, horizon_days))
    }

    /// The point maximizing net proceeds discounted at the daily return hurdle over the median
    /// wait, so each SKU trades price against its own sell time. A loss is not discounted: when no
    /// price clears overhead the least loss wins, whatever its wait.
    fn at_best_return(&self, policy: &ProfitPerDay) -> Option<CurvePoint> {
        let points = &self.by_sell_time;
        let (first, last) = (points.first()?, points.last()?);
        let discounted_net = |sell_days: f64| {
            let net = net_proceeds_at_price(at_sell_time(points, sell_days).price, policy);
            if net > 0.0 {
                net * (-policy.daily_return_hurdle * sell_days).exp()
            } else {
                net
            }
        };
        let best = maximize_over_candidates(
            &log_spaced_horizons(median(first), median(last), BEST_RETURN_SAMPLE_COUNT),
            discounted_net,
        )?;
        Some(at_sell_time(points, best.argument))
    }
}

/// `points` have observed sell times, fastest first.
fn at_sell_time(points: &[CurvePoint], horizon_days: f64) -> CurvePoint {
    let (first, last) = (&points[0], &points[points.len() - 1]);
    if horizon_days <= median(first) {
        return first.clone();
    }
    if horizon_days >= median(last) {
        return last.clone();
    }
    let upper_index = points
        .iter()
        .position(|p| median(p) >= horizon_days)
        .expect("a slower point");
    let (lower, upper) = (&points[upper_index - 1], &points[upper_index]);
    if median(lower) == median(upper) {
        return lower.clone();
    }
    interpolate(lower, upper, horizon_ratio(lower, upper, horizon_days))
}

/// Position of a horizon between two curve points. Interpolation mixes buyer interval and win
/// share linearly, so the median (ln2 * interval / share) is a linear-fractional function of the
/// ratio and inverts in closed form. When either input is missing the stored median mixes
/// linearly instead, the branch `interpolate` takes too.
fn horizon_ratio(lower: &CurvePoint, upper: &CurvePoint, horizon_days: f64) -> f64 {
    let ratio = match (
        is_positive(lower.buyer_interval_days),
        is_positive(upper.buyer_interval_days),
        is_positive(lower.store_win_share),
        is_positive(upper.store_win_share),
    ) {
        (Some(lower_interval), Some(upper_interval), Some(lower_share), Some(upper_share)) => {
            (horizon_days * lower_share - LN_2 * lower_interval)
                / (LN_2 * (upper_interval - lower_interval)
                    - horizon_days * (upper_share - lower_share))
        }
        _ => (horizon_days - median(lower)) / (median(upper) - median(lower)),
    };
    if ratio.is_finite() {
        ratio.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub fn net_proceeds_at_price(price: f64, policy: &ProfitPerDay) -> f64 {
    price * (1.0 - policy.relative_overhead) - policy.static_overhead_per_unit
}

/// The decision for one SKU under a policy: the policy's point on the curve, then the floor, then
/// for profit per day the snap under a shipping threshold. Without a curve point the current
/// price is kept, if there is one.
pub fn select_decision(
    curve: &Curve,
    policy: &Policy,
    current_price: Option<f64>,
    apply_constraint: Option<ApplyConstraint>,
) -> Option<Decision> {
    let method = policy.method();
    let requested = match policy {
        Policy::Percentile { percentile } => curve.at_percentile(*percentile),
        Policy::TargetHorizon { horizon_days } => curve.at_horizon(*horizon_days),
        Policy::ProfitPerDay(p) => curve.at_best_return(p),
    };
    let Some(requested) = requested else {
        let current = current_price.filter(|price| *price > 0.0)?;
        let mut kept = Decision::new(
            method,
            round_currency(current),
            Constraint::CurrentPrice,
            Basis::CurrentPrice,
            ForecastStatus::Unavailable,
        )
        .with_policy(policy);
        kept.unconstrained_price = Some(round_currency(current));
        return Some(kept);
    };

    let constrained = apply_constraint.map_or(
        Constrained {
            price: requested.price,
            constraint: Constraint::Unconstrained,
        },
        |apply| apply(requested.price),
    );
    let policy_price = round_currency(constrained.price);
    let snap = match policy {
        Policy::ProfitPerDay(p) => p.shipping_threshold_snap.as_ref().and_then(|snap| {
            shipping_threshold_snap::consider(&SnapInputs {
                policy_price,
                snap,
                daily_return_hurdle: p.daily_return_hurdle,
                overhead_rate: p.relative_overhead,
                net_proceeds: &|price| net_proceeds_at_price(price, p),
                sell_days: &|price| {
                    curve
                        .at_price(price)
                        .filter(|point| point.supply_status == Some(SupplyStatus::Observed))
                        .and_then(|point| point.estimated_median_sell_days)
                },
                allowed: &|price| {
                    apply_constraint.is_none_or(|apply| round_currency(apply(price).price) <= price)
                },
            })
        }),
        _ => None,
    };
    let selected_price = match &snap {
        Some(s) if s.outcome == SnapOutcome::Snapped => s.snap_price,
        _ => policy_price,
    };
    let final_point = curve
        .at_price(selected_price)
        .unwrap_or_else(|| requested.clone());
    let forecast_status = if final_point.supply_status != Some(SupplyStatus::Observed) {
        ForecastStatus::Unavailable
    } else if selected_price < curve.minimum_price() {
        ForecastStatus::LowerBound
    } else if selected_price > curve.maximum_price() {
        ForecastStatus::UpperBound
    } else {
        ForecastStatus::Interpolated
    };
    let mut decision = Decision::new(
        method,
        selected_price,
        constrained.constraint,
        Basis::Modeled,
        forecast_status,
    )
    .at_point(&final_point)
    .with_policy(policy);
    decision.unconstrained_price = Some(round_currency(requested.price));
    if let Policy::ProfitPerDay(p) = policy
        && net_proceeds_at_price(selected_price, p) <= 0.0
    {
        decision.unprofitable = Some(true);
    }
    decision.shipping_threshold_snap = snap;
    Some(decision)
}

/// Pricing details as a pricing run stores them, for reading the decision back.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDecision {
    pub pricing_model_version: Option<String>,
    pub decision: Option<Decision>,
    pub shadow_decision: Option<Decision>,
    pub percentile_used: Option<f64>,
    pub suggested_price: Option<f64>,
    pub marketplace_price: Option<f64>,
    pub historical_sales_velocity_days: Option<f64>,
    pub estimated_time_to_sell_days: Option<f64>,
    pub percentiles: Option<Vec<PercentileDetail>>,
}

fn curve_of(details: &PersistedDecision) -> Curve {
    Curve::new(to_pricing_curve(
        details.percentiles.as_deref().unwrap_or_default(),
    ))
}

/// The decision a stored price was listed under: the current model's own record, or one
/// reconstructed from the percentile an older run used.
pub fn read_decision(details: Option<&PersistedDecision>) -> Option<Decision> {
    let details = details?;
    if let Some(stored) = details
        .decision
        .as_ref()
        .filter(|_| details.pricing_model_version.as_deref() == Some(MODEL_VERSION))
    {
        return Some(rehydrate(
            details,
            stored,
            details.marketplace_price.unwrap_or(stored.selected_price),
        ));
    }
    let percentile_used = details.percentile_used?;
    let curve = curve_of(details);
    let point = curve.at_percentile(percentile_used);
    let unconstrained_price = details.suggested_price.or(point.as_ref().map(|p| p.price));
    let selected_price = details
        .marketplace_price
        .or(unconstrained_price)
        .filter(|price| *price > 0.0)?;
    let final_point = curve.at_price(selected_price);
    let either = |field: fn(&CurvePoint) -> Option<f64>| {
        final_point
            .as_ref()
            .and_then(field)
            .or(point.as_ref().and_then(field))
    };
    let constraint = match unconstrained_price {
        Some(unconstrained) if (selected_price - unconstrained).abs() >= 0.005 => Constraint::Floor,
        _ => Constraint::Unconstrained,
    };
    let mut decision = Decision::new(
        Method::Percentile,
        selected_price,
        constraint,
        Basis::LegacyUnknown,
        ForecastStatus::Unavailable,
    );
    decision.unconstrained_price = unconstrained_price;
    decision.equivalent_percentile = either(|p| Some(p.percentile)).or(Some(percentile_used));
    decision.configured_percentile = Some(percentile_used);
    decision.buyer_interval_days =
        either(|p| p.buyer_interval_days).or(details.historical_sales_velocity_days);
    decision.store_win_share = either(|p| p.store_win_share);
    decision.estimated_median_sell_days =
        either(|p| p.estimated_median_sell_days).or(details.estimated_time_to_sell_days);
    decision.qualifying_sales_count = either(|p| p.qualifying_sales_count);
    decision.history_capped = final_point
        .as_ref()
        .and_then(|p| p.history_capped)
        .or(point.as_ref().and_then(|p| p.history_capped));
    decision.listings_count = either(|p| p.listings_count);
    decision.supply_status = final_point
        .as_ref()
        .and_then(|p| p.supply_status)
        .or(point.as_ref().and_then(|p| p.supply_status));
    Some(decision)
}

/// A stored decision read at the price actually listed, with the curve's forecast there.
fn rehydrate(details: &PersistedDecision, stored: &Decision, selected_price: f64) -> Decision {
    let final_point = curve_of(details).at_price(selected_price);
    let point = final_point.as_ref();
    Decision {
        selected_price,
        unconstrained_price: stored.unconstrained_price.or(Some(stored.selected_price)),
        equivalent_percentile: point.map(|p| p.percentile).or(stored.equivalent_percentile),
        buyer_interval_days: point
            .and_then(|p| p.buyer_interval_days)
            .or(stored.buyer_interval_days),
        store_win_share: point
            .and_then(|p| p.store_win_share)
            .or(stored.store_win_share),
        estimated_median_sell_days: point
            .and_then(|p| p.estimated_median_sell_days)
            .or(stored.estimated_median_sell_days),
        qualifying_sales_count: point
            .and_then(|p| p.qualifying_sales_count)
            .or(stored.qualifying_sales_count),
        history_capped: point
            .and_then(|p| p.history_capped)
            .or(stored.history_capped),
        listings_count: point
            .and_then(|p| p.listings_count)
            .or(stored.listings_count),
        supply_status: point.and_then(|p| p.supply_status).or(stored.supply_status),
        ..stored.clone()
    }
}

/// The shadow plan's decision for a stored price, when the current model recorded one.
pub fn read_shadow_decision(details: Option<&PersistedDecision>) -> Option<Decision> {
    let details = details?;
    if details.pricing_model_version.as_deref() != Some(MODEL_VERSION) {
        return None;
    }
    let shadow = details.shadow_decision.as_ref()?;
    Some(rehydrate(details, shadow, shadow.selected_price))
}

/// Two FNV-1a hashes of the text's UTF-16 code units, as `hashText` writes them.
fn hash_text(value: &str) -> String {
    let hash = |seed: u32| {
        let result = value.encode_utf16().fold(seed, |result, unit| {
            (result ^ u32::from(unit)).wrapping_mul(16_777_619)
        });
        format!("{result:08x}")
    };
    format!("{}{}", hash(2_166_136_261), hash(3_335_557_771))
}

/// One SKU of a portfolio: its curve, its current price, and the floor its price must clear.
pub struct PortfolioItem<'a> {
    pub sku: i64,
    pub current_price: Option<f64>,
    pub curve: Curve,
    /// What the floor depends on, so a plan changes when the floor does.
    pub constraint_identity: Option<String>,
    pub apply_constraint: Option<ApplyConstraint<'a>>,
}

impl PortfolioItem<'_> {
    fn has_modeled_curve(&self) -> bool {
        self.curve.points.iter().any(is_observed_sell_time)
    }
}

/// Shortest and longest observed median sell time across the portfolio. Below the minimum every
/// SKU sits at its fastest curve point; above the maximum every SKU sits at its slowest, so this
/// is the range over which a target horizon changes any price.
pub fn observed_horizon_range(items: &[PortfolioItem]) -> Option<(f64, f64)> {
    let days: Vec<f64> = items
        .iter()
        .flat_map(|item| {
            item.curve
                .points
                .iter()
                .filter(|p| is_observed_sell_time(p))
                .map(median)
        })
        .collect();
    let maximum_days = days.iter().copied().fold(0.0, f64::max);
    if maximum_days == 0.0 {
        return None;
    }
    let minimum_days = days.iter().copied().fold(f64::INFINITY, f64::min);
    Some((minimum_days.max(0.1), maximum_days))
}

/// Decisions across a portfolio in its order, under the policy each item gets.
pub fn portfolio_decisions<'p>(
    items: &[PortfolioItem],
    policy_for: impl Fn(&PortfolioItem) -> &'p Policy,
) -> Vec<(i64, Decision)> {
    items
        .iter()
        .filter_map(|item| {
            select_decision(
                &item.curve,
                policy_for(item),
                item.current_price,
                item.apply_constraint,
            )
            .map(|d| (item.sku, d))
        })
        .collect()
}

fn decision_value(decisions: &[(i64, Decision)]) -> f64 {
    round_currency(
        decisions
            .iter()
            .fold(0.0, |sum, (_, d)| sum + d.selected_price),
    )
}

struct HorizonCandidate {
    horizon_days: f64,
    value: f64,
    decisions: Vec<(i64, Decision)>,
}

struct ClosestHorizon {
    best: Rc<HorizonCandidate>,
    minimum_reachable_value: f64,
    maximum_reachable_value: f64,
}

fn find_closest_horizon(
    items: &[PortfolioItem],
    baseline_value: f64,
    minimum_horizon: f64,
    maximum_horizon: f64,
) -> ClosestHorizon {
    let evaluate = |horizon_days: f64| {
        let policy = Policy::TargetHorizon { horizon_days };
        let decisions = portfolio_decisions(items, |_| &policy);
        Rc::new(HorizonCandidate {
            horizon_days,
            value: decision_value(&decisions),
            decisions,
        })
    };
    let distance = |candidate: &HorizonCandidate| (candidate.value - baseline_value).abs();
    let samples: Vec<Rc<HorizonCandidate>> =
        log_spaced_horizons(minimum_horizon, maximum_horizon, VALUE_MATCH_SAMPLE_COUNT)
            .into_iter()
            .map(evaluate)
            .collect();
    let mut best = samples
        .iter()
        .skip(1)
        .fold(samples[0].clone(), |closest, candidate| {
            if distance(candidate) < distance(&closest) {
                candidate.clone()
            } else {
                closest
            }
        });

    // Bisect every pair of samples that straddles the baseline; log spacing keeps each step
    // proportional to the horizon.
    let mut index = 1;
    while best.value != baseline_value && index < samples.len() {
        let (mut left, mut right) = (samples[index - 1].clone(), samples[index].clone());
        index += 1;
        if (left.value - baseline_value) * (right.value - baseline_value) >= 0.0 {
            continue;
        }
        for _ in 0..VALUE_MATCH_REFINEMENTS {
            let middle = evaluate((left.horizon_days * right.horizon_days).sqrt());
            if distance(&middle) < distance(&best) {
                best = middle.clone();
            }
            if (left.value - baseline_value) * (middle.value - baseline_value) <= 0.0 {
                right = middle;
            } else {
                left = middle;
            }
        }
    }

    ClosestHorizon {
        minimum_reachable_value: samples
            .iter()
            .map(|s| s.value)
            .fold(f64::INFINITY, f64::min),
        maximum_reachable_value: samples
            .iter()
            .map(|s| s.value)
            .fold(f64::NEG_INFINITY, f64::max),
        best,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioPlan {
    pub id: String,
    pub model_version: String,
    pub created_at: String,
    pub baseline_value: f64,
    pub selected_one_copy_value: f64,
    pub value_difference: f64,
    pub value_tolerance: f64,
    pub match_status: MatchStatus,
    pub minimum_reachable_value: f64,
    pub maximum_reachable_value: f64,
    pub resolved_horizon_days: f64,
    pub inventory_snapshot_id: String,
    pub modeled_sku_count: usize,
    pub unavailable_baseline_sku_count: usize,
    pub raised_count: usize,
    pub lowered_count: usize,
    pub held_count: usize,
    pub sparse_decision_count: usize,
    pub capped_history_count: usize,
}

pub struct ResolvedPortfolio {
    pub plan: PortfolioPlan,
    pub decisions_by_sku: HashMap<i64, Decision>,
}

/// The one horizon at which one copy of every SKU with a current price is worth what it is
/// listed at now, and each SKU's decision there: the shadow plan a pricing run records beside
/// its own decisions.
pub fn resolve_value_matched_portfolio_plan(
    items: &[PortfolioItem],
    created_at: DateTime<Utc>,
    cohort_id: Option<&str>,
) -> Result<ResolvedPortfolio, String> {
    let mut seen = HashSet::new();
    let mut duplicates: Vec<i64> = Vec::new();
    for item in items {
        if !seen.insert(item.sku) && !duplicates.contains(&item.sku) {
            duplicates.push(item.sku);
        }
    }
    if !duplicates.is_empty() {
        let listed: Vec<String> = duplicates.iter().map(i64::to_string).collect();
        return Err(format!(
            "Portfolio pricing requires one row per SKU. Duplicates: {}",
            listed.join(", ")
        ));
    }

    let created_at = iso(created_at);
    let cohort_id = cohort_id.unwrap_or("unspecified");
    let baseline: Vec<&PortfolioItem> = items
        .iter()
        .filter(|item| {
            item.current_price
                .is_some_and(|price| price.is_finite() && price > 0.0)
        })
        .collect();
    let current = |item: &PortfolioItem| item.current_price.unwrap_or(0.0);
    let unavailable_baseline_sku_count = items.len() - baseline.len();
    let modeled_sku_count = baseline
        .iter()
        .filter(|item| item.has_modeled_curve())
        .count();
    let baseline_value = round_currency(baseline.iter().fold(0.0, |sum, item| sum + current(item)));
    let baseline_items: Vec<PortfolioItem> = baseline
        .iter()
        .map(|item| PortfolioItem {
            sku: item.sku,
            current_price: item.current_price,
            curve: item.curve.clone(),
            constraint_identity: item.constraint_identity.clone(),
            apply_constraint: item.apply_constraint,
        })
        .collect();
    let (minimum_horizon, maximum_horizon) =
        observed_horizon_range(&baseline_items).unwrap_or((1.0, 365.0));
    let closest = find_closest_horizon(
        &baseline_items,
        baseline_value,
        minimum_horizon,
        maximum_horizon,
    );
    let value_tolerance = round_currency((baseline_value * 0.0001).max(0.01));
    let value_difference = round_currency(closest.best.value - baseline_value);
    let outside_reachable_range = baseline_value
        < closest.minimum_reachable_value - value_tolerance
        || baseline_value > closest.maximum_reachable_value + value_tolerance;
    let match_status = if modeled_sku_count == 0 {
        MatchStatus::Infeasible
    } else if value_difference.abs() <= value_tolerance {
        MatchStatus::Matched
    } else if outside_reachable_range {
        MatchStatus::Boundary
    } else {
        MatchStatus::Infeasible
    };

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Snapshot<'a> {
        sku: i64,
        current_price: f64,
        constraint_identity: &'a str,
        curve: &'a [CurvePoint],
    }
    let mut snapshot: Vec<String> = baseline_items
        .iter()
        .map(|item| {
            js_json(&Snapshot {
                sku: item.sku,
                current_price: round_currency(current(item)),
                constraint_identity: item.constraint_identity.as_deref().unwrap_or(""),
                curve: &item.curve.points,
            })
        })
        .collect();
    snapshot.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let inventory_snapshot_id = hash_text(&snapshot.join("|"));
    let resolved_horizon_days = closest.best.horizon_days;
    let plan_id = format!(
        "shadow-{}",
        hash_text(
            &[
                MODEL_VERSION,
                cohort_id,
                &inventory_snapshot_id,
                &created_at,
                &js_to_fixed(resolved_horizon_days, 6)
            ]
            .join("|")
        )
    );
    let decisions_by_sku: HashMap<i64, Decision> = closest
        .best
        .decisions
        .iter()
        .map(|(sku, decision)| {
            let decision = Decision {
                plan_id: Some(plan_id.clone()),
                target_horizon_days: Some(resolved_horizon_days),
                plan_match_status: Some(match_status),
                ..decision.clone()
            };
            (*sku, decision)
        })
        .collect();

    let (
        mut raised_count,
        mut lowered_count,
        mut held_count,
        mut sparse_decision_count,
        mut capped_history_count,
    ) = (0, 0, 0, 0, 0);
    for item in &baseline_items {
        let Some(decision) = decisions_by_sku.get(&item.sku) else {
            continue;
        };
        let current_price = round_currency(current(item));
        if decision.selected_price > current_price {
            raised_count += 1;
        } else if decision.selected_price < current_price {
            lowered_count += 1;
        } else {
            held_count += 1;
        }
        if decision.basis == Basis::Modeled
            && decision
                .qualifying_sales_count
                .is_none_or(|count| count < 3.0)
        {
            sparse_decision_count += 1;
        }
        if decision.history_capped == Some(true) {
            capped_history_count += 1;
        }
    }

    Ok(ResolvedPortfolio {
        plan: PortfolioPlan {
            id: plan_id,
            model_version: MODEL_VERSION.into(),
            created_at,
            baseline_value,
            selected_one_copy_value: closest.best.value,
            value_difference,
            value_tolerance,
            match_status,
            minimum_reachable_value: closest.minimum_reachable_value,
            maximum_reachable_value: closest.maximum_reachable_value,
            resolved_horizon_days,
            inventory_snapshot_id,
            modeled_sku_count,
            unavailable_baseline_sku_count,
            raised_count,
            lowered_count,
            held_count,
            sparse_decision_count,
            capped_history_count,
        },
        decisions_by_sku,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(percentile: f64, price: f64, days: f64) -> CurvePoint {
        CurvePoint {
            percentile,
            price,
            estimated_median_sell_days: Some(days),
            supply_status: Some(SupplyStatus::Observed),
            ..CurvePoint::default()
        }
    }

    fn curve() -> Curve {
        Curve::new(vec![point(10.0, 5.0, 10.0), point(90.0, 15.0, 100.0)])
    }

    fn identity_curve() -> Curve {
        Curve::new(vec![
            CurvePoint {
                buyer_interval_days: Some(10.0 / LN_2),
                store_win_share: Some(1.0),
                ..point(10.0, 5.0, 10.0)
            },
            CurvePoint {
                buyer_interval_days: Some(50.0 / LN_2),
                store_win_share: Some(0.5),
                ..point(90.0, 15.0, 100.0)
            },
        ])
    }

    fn horizon(horizon_days: f64) -> Policy {
        Policy::TargetHorizon { horizon_days }
    }

    fn profit_per_day(daily_return_hurdle: f64, static_overhead_per_unit: f64) -> Policy {
        Policy::ProfitPerDay(ProfitPerDay {
            daily_return_hurdle,
            relative_overhead: 0.15,
            static_overhead_per_unit,
            shipping_threshold_snap: None,
        })
    }

    fn decide(curve: &Curve, policy: &Policy) -> Decision {
        select_decision(curve, policy, None, None).unwrap()
    }

    #[test]
    fn non_positive_model_inputs_are_dropped_so_the_stored_median_is_used() {
        let normalized = to_pricing_curve(&[PercentileDetail {
            percentile: 50.0,
            suggested_price: 10.0,
            historical_sales_velocity_days: Some(0.0),
            store_win_share: Some(0.5),
            estimated_time_to_sell_days: Some(12.0),
            ..PercentileDetail::default()
        }]);
        assert_eq!(normalized[0].buyer_interval_days, None);
        assert_eq!(normalized[0].store_win_share, Some(0.5));
        assert_eq!(normalized[0].estimated_median_sell_days, Some(12.0));
    }

    #[test]
    fn target_horizons_interpolate_continuously() {
        let (early, late) = (
            decide(&curve(), &horizon(20.0)),
            decide(&curve(), &horizon(80.0)),
        );
        assert!(early.selected_price < late.selected_price);
        assert!(early.equivalent_percentile < late.equivalent_percentile);
        assert!(
            early.equivalent_percentile.unwrap() >= 0.0
                && late.equivalent_percentile.unwrap() <= 100.0
        );

        for horizon_days in [10.0, 15.0, 20.0, 40.0, 80.0, 100.0] {
            let decision = decide(&identity_curve(), &horizon(horizon_days));
            let identity =
                LN_2 * decision.buyer_interval_days.unwrap() / decision.store_win_share.unwrap();
            assert!(
                (identity - decision.estimated_median_sell_days.unwrap()).abs() < 1e-10,
                "the median identity holds"
            );
            assert!(
                (identity - horizon_days).abs() < 0.15,
                "the rounded price stays close to the horizon"
            );
        }
        let exact = decide(&identity_curve(), &horizon(40.0));
        assert_eq!(
            exact.selected_price, 10.0,
            "the closed-form inversion lands on the exact interpolated price"
        );
        assert!((exact.estimated_median_sell_days.unwrap() - 40.0).abs() < 1e-9);
        let linear = decide(&curve(), &horizon(55.0));
        assert_eq!(linear.selected_price, 10.0);
        assert!(
            (linear.estimated_median_sell_days.unwrap() - 55.0).abs() < 1e-9,
            "curves without the model inputs invert linearly"
        );
        assert_eq!(
            decide(&identity_curve(), &horizon(5.0)).selected_price,
            5.0,
            "below the fastest point pins to it"
        );
        assert_eq!(
            decide(&identity_curve(), &horizon(500.0)).selected_price,
            15.0,
            "above the slowest point pins to it"
        );
    }

    #[test]
    fn profit_per_day_trades_price_against_sell_time() {
        let patient = decide(&identity_curve(), &profit_per_day(0.001, 0.3));
        assert_eq!(
            patient.selected_price, 15.0,
            "a low hurdle waits for the slow, high point"
        );
        assert_eq!(patient.daily_return_hurdle, Some(0.001));
        assert_eq!(patient.basis, Basis::Modeled);
        assert_eq!(patient.unprofitable, None);
        assert_eq!(
            decide(&identity_curve(), &profit_per_day(0.05, 0.3)).selected_price,
            5.0,
            "a high hurdle takes the fast, low point"
        );
        let middling = decide(&identity_curve(), &profit_per_day(0.012, 0.3)).selected_price;
        assert!(
            middling > 5.0 && middling < 15.0,
            "a middling hurdle lands between the points"
        );
        let unprofitable = select_decision(
            &identity_curve(),
            &profit_per_day(0.005, 20.0),
            Some(9.0),
            None,
        )
        .unwrap();
        assert_eq!(
            unprofitable.selected_price, 15.0,
            "overhead above every price lists at the slowest, highest point"
        );
        assert_eq!(unprofitable.basis, Basis::Modeled);
        assert_eq!(unprofitable.unprofitable, Some(true));
        let slow_loss = Curve::new(vec![point(50.0, 15.0, 10.0), point(60.0, 14.0, 400.0)]);
        assert_eq!(
            decide(&slow_loss, &profit_per_day(0.005, 13.0)).selected_price,
            15.0,
            "a loss is not discounted"
        );
    }

    #[test]
    fn constrained_prices_are_projected_back_through_the_curve() {
        let floor = |price| {
            move |_: f64| Constrained {
                price,
                constraint: Constraint::Floor,
            }
        };
        let at_floor = floor(12.34);
        let decision =
            select_decision(&identity_curve(), &horizon(20.0), None, Some(&at_floor)).unwrap();
        assert!(
            (LN_2 * decision.buyer_interval_days.unwrap() / decision.store_win_share.unwrap()
                - decision.estimated_median_sell_days.unwrap())
            .abs()
                < 1e-10
        );
        let steep = Curve::new(vec![point(5.0, 10.0, 10.0), point(95.0, 20.0, 100.0)]);
        let at_twenty = floor(20.0);
        let constrained =
            select_decision(&steep, &horizon(10.0), Some(10.0), Some(&at_twenty)).unwrap();
        assert_eq!(
            (
                constrained.selected_price,
                constrained.unconstrained_price,
                constrained.equivalent_percentile,
                constrained.estimated_median_sell_days
            ),
            (20.0, Some(10.0), Some(95.0), Some(100.0))
        );
        let above = floor(25.0);
        let above_curve =
            select_decision(&steep, &horizon(10.0), Some(10.0), Some(&above)).unwrap();
        assert_eq!(
            (above_curve.selected_price, above_curve.forecast_status),
            (25.0, ForecastStatus::UpperBound)
        );
    }

    fn item(sku: i64, current_price: Option<f64>, curve: Curve) -> PortfolioItem<'static> {
        PortfolioItem {
            sku,
            current_price,
            curve,
            constraint_identity: None,
            apply_constraint: None,
        }
    }

    fn at_noon() -> DateTime<Utc> {
        "2026-08-31T12:00:00.000Z".parse().unwrap()
    }

    #[test]
    fn a_portfolio_is_value_matched_at_one_horizon() {
        let resolved = resolve_value_matched_portfolio_plan(
            &[
                item(1, Some(10.0), curve()),
                item(
                    2,
                    Some(20.0),
                    Curve::new(vec![point(10.0, 10.0, 10.0), point(90.0, 30.0, 100.0)]),
                ),
                item(3, Some(7.0), Curve::new(Vec::new())),
            ],
            at_noon(),
            None,
        )
        .unwrap();
        assert!(resolved.plan.value_difference.abs() <= 0.02);
        assert_eq!(resolved.plan.baseline_value, 37.0);
        assert_eq!(resolved.plan.match_status, MatchStatus::Matched);
        assert_eq!(
            resolved.decisions_by_sku[&3].constraint,
            Constraint::CurrentPrice
        );
        assert_eq!(resolved.plan.created_at, "2026-08-31T12:00:00.000Z");

        let missing = resolve_value_matched_portfolio_plan(
            &[item(10, Some(10.0), curve()), item(11, None, curve())],
            at_noon(),
            None,
        )
        .unwrap();
        assert_eq!(missing.plan.unavailable_baseline_sku_count, 1);
        assert!(!missing.decisions_by_sku.contains_key(&11));
        assert!(
            (missing.plan.selected_one_copy_value - 10.0).abs() <= missing.plan.value_tolerance
        );

        let shifted = Curve::new(
            curve()
                .points
                .iter()
                .map(|p| CurvePoint {
                    price: p.price + 1.0,
                    ..p.clone()
                })
                .collect(),
        );
        let changed =
            resolve_value_matched_portfolio_plan(&[item(1, Some(10.0), shifted)], at_noon(), None)
                .unwrap();
        let original =
            resolve_value_matched_portfolio_plan(&[item(1, Some(10.0), curve())], at_noon(), None)
                .unwrap();
        assert_ne!(changed.plan.id, original.plan.id);

        let boundary = resolve_value_matched_portfolio_plan(
            &[item(
                20,
                Some(10.0),
                Curve::new(vec![point(5.0, 20.0, 10.0), point(95.0, 30.0, 100.0)]),
            )],
            at_noon(),
            None,
        )
        .unwrap();
        assert_eq!(boundary.plan.match_status, MatchStatus::Boundary);
        assert_eq!(boundary.plan.minimum_reachable_value, 20.0);
        assert_eq!(boundary.plan.value_difference, 10.0);

        let duplicate = resolve_value_matched_portfolio_plan(
            &[item(30, Some(10.0), curve()), item(30, Some(10.0), curve())],
            at_noon(),
            None,
        );
        assert_eq!(
            duplicate.err().unwrap(),
            "Portfolio pricing requires one row per SKU. Duplicates: 30"
        );
    }

    #[test]
    fn stored_decisions_read_back_at_the_listed_price() {
        let legacy = read_decision(Some(&PersistedDecision {
            percentile_used: Some(65.0),
            suggested_price: Some(12.0),
            marketplace_price: Some(13.0),
            estimated_time_to_sell_days: Some(40.0),
            ..PersistedDecision::default()
        }))
        .unwrap();
        assert_eq!(
            (
                legacy.method,
                legacy.selected_price,
                legacy.unconstrained_price,
                legacy.constraint,
                legacy.basis,
                legacy.forecast_status
            ),
            (
                Method::Percentile,
                13.0,
                Some(12.0),
                Constraint::Floor,
                Basis::LegacyUnknown,
                ForecastStatus::Unavailable
            )
        );
        let shadow = Decision::new(
            Method::TargetHorizon,
            12.0,
            Constraint::Unconstrained,
            Basis::Modeled,
            ForecastStatus::Interpolated,
        );
        let stored = |version: &str| PersistedDecision {
            pricing_model_version: Some(version.into()),
            shadow_decision: Some(shadow.clone()),
            ..PersistedDecision::default()
        };
        assert_eq!(read_shadow_decision(Some(&stored("unknown-model"))), None);
        assert_eq!(
            read_shadow_decision(Some(&stored(MODEL_VERSION)))
                .unwrap()
                .basis,
            Basis::Modeled
        );
    }

    #[test]
    fn a_curve_with_no_point_within_a_year_has_no_forecast_to_trade_against() {
        let hopeless = vec![point(5.0, 6.0, 400.0), point(95.0, 25.0, 900.0)];
        assert!(!Curve::new(hopeless.clone()).forecasts_within_year());
        assert!(curve().forecasts_within_year());
        assert!(
            Curve::new(vec![CurvePoint {
                estimated_median_sell_days: Some(365.0),
                ..hopeless[0].clone()
            }])
            .forecasts_within_year(),
            "a year exactly still counts"
        );
        assert!(
            Curve::new(Vec::new()).forecasts_within_year(),
            "no observed sell times is judged by supply status instead"
        );
    }

    #[test]
    fn a_decision_is_written_as_the_node_app_writes_it() {
        let decision = decide(&curve(), &horizon(55.0));
        assert_eq!(
            serde_json::to_value(&decision).unwrap(),
            serde_json::json!({
                "method": "target-horizon", "selectedPrice": 10.0, "unconstrainedPrice": 10.0,
                "equivalentPercentile": 50.0, "targetHorizonDays": 55.0, "estimatedMedianSellDays": 55.0,
                "supplyStatus": "observed", "constraint": "none", "basis": "modeled", "forecastStatus": "interpolated",
            })
        );
    }

    /// Node: resolveValueMatchedPortfolioPlan on these items, cohort-7, at noon on 2026-08-31.
    #[test]
    fn a_plan_and_its_decisions_match_the_node_app_to_the_hash() {
        let mut detailed = point(10.0, 10.0, 10.0);
        detailed.buyer_interval_days = Some(3.25);
        detailed.store_win_share = Some(0.4);
        detailed.qualifying_sales_count = Some(4.0);
        detailed.history_capped = Some(false);
        detailed.listings_count = Some(3.0);
        let resolved = resolve_value_matched_portfolio_plan(
            &[
                item(1, Some(10.0), curve()),
                PortfolioItem {
                    constraint_identity: Some("floor:1.5".into()),
                    ..item(
                        2,
                        Some(20.0),
                        Curve::new(vec![detailed, point(90.0, 30.0, 100.0)]),
                    )
                },
                item(3, Some(7.0), Curve::new(Vec::new())),
            ],
            at_noon(),
            Some("cohort-7"),
        )
        .unwrap();
        let node_plan: serde_json::Value = serde_json::from_str(
            r#"{"id":"shadow-e2e7b1ff29c0b6b1","modelVersion":"pooled-supply-v1","createdAt":"2026-08-31T12:00:00.000Z","baselineValue":37,"selectedOneCopyValue":37,"valueDifference":0,"valueTolerance":0.01,"matchStatus":"matched","minimumReachableValue":22.93,"maximumReachableValue":52,"resolvedHorizonDays":53.572290774509945,"inventorySnapshotId":"a9e383570f4f97bd","modeledSkuCount":2,"unavailableBaselineSkuCount":0,"raisedCount":1,"loweredCount":1,"heldCount":1,"sparseDecisionCount":2,"cappedHistoryCount":0}"#,
        )
        .unwrap();
        let ours = serde_json::to_value(&resolved.plan).unwrap();
        for (key, node) in node_plan.as_object().unwrap() {
            assert_eq!(ours[key].as_f64().or(None), node.as_f64(), "{key}");
            assert_eq!(ours[key].as_str(), node.as_str(), "{key}");
        }
        let decision = |sku| serde_json::to_value(&resolved.decisions_by_sku[&sku]).unwrap();
        assert_eq!(decision(2)["selectedPrice"], 20.16);
        assert_eq!(decision(2)["equivalentPercentile"], 50.64);
        assert_eq!(decision(2)["estimatedMedianSellDays"], 55.72);
        assert_eq!(decision(1)["selectedPrice"], 9.84);
        assert_eq!(decision(3)["basis"], "current-price");
        assert_eq!(decision(3)["planId"], "shadow-e2e7b1ff29c0b6b1");
    }
}
