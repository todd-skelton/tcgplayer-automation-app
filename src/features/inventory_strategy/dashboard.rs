//! What the strategy dashboard shows for the inventory and each product line: listed value under
//! each policy and hurdle, and how long it is expected to take to sell. Ported from
//! `types/inventoryStrategy.ts`; the JSON keeps the Node app's shape.
use serde::{Deserialize, Serialize};

/// Daily return hurdles the profit-per-day policy is evaluated at.
pub const HURDLES: [f64; 6] = [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02];

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeDistribution {
    pub median_days: f64,
    pub p75_days: f64,
    pub p90_days: f64,
}

/// Portfolio value, wait, and price movement under one decision per SKU.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSummary {
    pub one_copy_value: f64,
    pub physical_value: f64,
    pub modeled_sku_count: usize,
    pub raised_count: usize,
    pub lowered_count: usize,
    pub held_count: usize,
    pub estimated_time: Option<TimeDistribution>,
}

/// The profit-per-day policy evaluated at one daily return hurdle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HurdleScenario {
    #[serde(flatten)]
    pub summary: DecisionSummary,
    pub daily_return_hurdle: f64,
    /// Whether this is the hurdle the product line is configured with.
    pub configured: bool,
}

pub const MIN_PERCENTILE: f64 = 5.0;
pub const MAX_PERCENTILE: f64 = 95.0;

/// 5, 10, ... 95: the percentiles a knee is looked for among.
pub fn percentiles() -> Vec<f64> {
    (1..=19).map(|step| f64::from(step) * 5.0).collect()
}

/// Every whole percentile from 5 to 95, for the preview.
pub fn preview_percentiles() -> Vec<f64> {
    (5..=95).map(f64::from).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
    Unavailable,
}

/// Listed value and wait with every SKU priced at one percentile of its curve.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub percentile: f64,
    pub knee_score: Option<f64>,
    pub listed_value: f64,
    pub delta_from_current_policy: f64,
    pub delta_percent_from_current_policy: Option<f64>,
    pub modeled_sku_count: usize,
    pub modeled_unit_count: i64,
    pub interpolated_sku_count: usize,
    pub interpolated_unit_count: i64,
    pub time_modeled_unit_count: i64,
    pub estimated_time: Option<TimeDistribution>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComparisonKey {
    Current,
    Percentile,
    TargetHorizonShadow,
    ProfitPerDay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Current,
    Active,
    Benchmark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanState {
    None,
    Single,
    Mixed,
}

/// The inventory under one policy, beside the current prices.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyComparison {
    #[serde(flatten)]
    pub summary: DecisionSummary,
    pub key: ComparisonKey,
    pub label: String,
    pub role: Role,
    pub plan_state: PlanState,
}

/// Listed value against target horizon, fitted across the horizons that change any price.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HorizonModel {
    pub minimum_horizon_days: f64,
    pub maximum_horizon_days: f64,
    pub curve: Option<crate::features::pricing::horizon_value_curve::HorizonValueCurve>,
    pub fit_confidence: Confidence,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductLine {
    pub key: String,
    pub product_line_id: Option<i64>,
    pub product_line: String,
    pub configured_percentile: Option<f64>,
    pub pricing_eligible: bool,
    pub sku_count: usize,
    pub unit_count: i64,
    pub current_listed_value: f64,
    pub estimated_market_value: f64,
    pub current_policy_value: f64,
    pub mathematical_knee_percentile: Option<f64>,
    pub estimated_percentile: Option<f64>,
    pub knee_range_minimum: Option<f64>,
    pub knee_range_maximum: Option<f64>,
    pub knee_confidence: Confidence,
    pub modeled_sku_count: usize,
    pub modeled_unit_count: i64,
    pub oldest_pricing_at: Option<String>,
    pub newest_pricing_at: Option<String>,
    pub matrix_percentiles: Vec<f64>,
    pub scenarios: Vec<Scenario>,
    pub policy_comparisons: Vec<PolicyComparison>,
    pub hurdle_sweep: Vec<HurdleScenario>,
    pub horizon_model: Option<HorizonModel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub seller_key: String,
    pub generated_at: String,
    /// The stored policy and profit-per-day settings, as the pricing configuration writes them.
    pub policy: serde_json::Value,
    pub profit_per_day: serde_json::Value,
    pub overall: ProductLine,
    pub product_lines: Vec<ProductLine>,
}
