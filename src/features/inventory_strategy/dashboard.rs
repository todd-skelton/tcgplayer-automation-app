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
