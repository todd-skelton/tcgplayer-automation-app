//! Shipping thresholds: the order values where shipping economics step, what shipping costs the
//! seller in each band, and the snap that lists a card just under a threshold when that returns
//! more. Ported from `app/features/shipping-thresholds` and `core/types/shippingThresholds.ts`;
//! the JSON keeps the Node app's shape, since pricing decisions store it.
#![allow(dead_code, reason = "the engine lands before the pricers that call it")]
use serde::{Deserialize, Serialize};

pub mod cost_model;

/// Order item values where shipping economics step: under $5 the buyer pays shipping, from $5
/// shipping is free, from $50 orders ship tracked ground, and from $250 they ship with signature.
pub const SHIPPING_THRESHOLDS: [f64; 3] = [5.0, 50.0, 250.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TierBasis {
    /// Learned from recent orders.
    Observed,
    /// The default, used while recent orders are too few.
    Default,
}

/// Buyer shipping and postage per order for one band of order item value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingTier {
    /// Lowest order item value in the tier; the next tier starts where this one ends.
    pub from_order_value: f64,
    /// Mean shipping the buyer paid per order.
    pub buyer_shipping: f64,
    /// Mean postage bought per order.
    pub postage: f64,
    /// Orders in the evidence window whose item value fell in the tier.
    pub order_count: usize,
    /// Of those, orders with purchased postage.
    pub postage_order_count: usize,
    pub basis: TierBasis,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OrderLine {
    pub sku: i64,
    pub quantity: usize,
    pub unit_price: f64,
}

/// What an order that was not canceled says about shipping: its item value, what the buyer paid
/// for shipping and the postage bought, when recorded, and what was in it.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderEvidence {
    pub item_value: f64,
    pub buyer_shipping: Option<f64>,
    pub postage: Option<f64>,
    pub lines: Vec<OrderLine>,
}

/// One unit sold and the value of everything else the buyer ordered with it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BasketEvidence {
    pub unit_price: f64,
    pub other_items_value: f64,
}

/// Shipping economics learned from a trailing window of the seller's own orders.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingCostModel {
    pub learned_at: String,
    pub evidence_window_days: i64,
    pub order_count: usize,
    pub tiers: Vec<ShippingTier>,
    pub baskets: Vec<BasketEvidence>,
}

/// What the profit-per-day policy needs to consider listing just under a threshold.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapPolicy {
    pub thresholds: Vec<f64>,
    /// A price up to this fraction above a threshold may be snapped just under it.
    pub snap_range: f64,
    pub cost_model: ShippingCostModel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapOutcome {
    /// Listed just under the threshold.
    Snapped,
    /// The snap was considered and the policy price returned more.
    Kept,
    /// The snap price was below the price floor.
    Floor,
}

/// A snap considered for one pricing decision, recorded so its results can be tracked.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingThresholdSnap {
    pub threshold: f64,
    pub outcome: SnapOutcome,
    /// Price the policy chose before the snap was considered.
    pub policy_price: f64,
    pub snap_price: f64,
    /// Expected shipping cost per unit (postage less buyer shipping, after fees) at each price.
    pub policy_price_shipping_cost: f64,
    pub snap_price_shipping_cost: f64,
    /// Net proceeds after shipping, discounted at the hurdle over the expected sell time.
    pub policy_price_return: f64,
    pub snap_price_return: f64,
    pub cost_model_learned_at: String,
}
