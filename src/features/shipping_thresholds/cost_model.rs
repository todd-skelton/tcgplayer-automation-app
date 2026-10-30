//! What shipping costs per order in each band of order value, learned from recent orders, and
//! what one more unit adds to the orders it joins: `shippingCostModel.ts`.
use super::*;
use crate::features::inventory_economics::ledger::assumptions::js_round;

/// A tier with fewer orders than this keeps its default.
pub const MINIMUM_TIER_ORDERS: usize = 10;
/// With fewer baskets than this near a threshold, its snap is not considered.
pub const MINIMUM_NEARBY_BASKETS: usize = 20;

/// Per-order values measured from production orders in October 2026. They only stand in for a
/// tier until its recent orders are numerous enough to learn from.
pub fn default_tiers() -> Vec<ShippingTier> {
    [
        (0.0, 1.49, 0.78),
        (SHIPPING_THRESHOLDS[0], 0.0, 0.83),
        (SHIPPING_THRESHOLDS[1], 0.0, 5.77),
        (SHIPPING_THRESHOLDS[2], 0.0, 9.8),
    ]
    .into_iter()
    .map(|(from_order_value, buyer_shipping, postage)| ShippingTier {
        from_order_value,
        buyer_shipping,
        postage,
        order_count: 0,
        postage_order_count: 0,
        basis: TierBasis::Default,
    })
    .collect()
}

fn to_cents(value: f64) -> i64 {
    js_round(value * 100.0)
}

fn round_currency(value: f64) -> f64 {
    js_round(value * 100.0) as f64 / 100.0
}

fn mean(values: &[f64]) -> f64 {
    values.iter().fold(0.0, |sum, value| sum + value) / values.len() as f64
}

fn learn_tier(
    tier: &ShippingTier,
    next_tier: Option<&ShippingTier>,
    orders: &[OrderEvidence],
) -> ShippingTier {
    let in_tier: Vec<&OrderEvidence> = orders
        .iter()
        .filter(|order| {
            to_cents(order.item_value) >= to_cents(tier.from_order_value)
                && next_tier
                    .is_none_or(|next| to_cents(order.item_value) < to_cents(next.from_order_value))
        })
        .collect();
    let buyer_shipping: Vec<f64> = in_tier
        .iter()
        .filter_map(|order| order.buyer_shipping)
        .collect();
    let postage: Vec<f64> = in_tier.iter().filter_map(|order| order.postage).collect();
    let learned =
        buyer_shipping.len() >= MINIMUM_TIER_ORDERS && postage.len() >= MINIMUM_TIER_ORDERS;
    ShippingTier {
        from_order_value: tier.from_order_value,
        buyer_shipping: if learned {
            round_currency(mean(&buyer_shipping))
        } else {
            tier.buyer_shipping
        },
        postage: if learned {
            round_currency(mean(&postage))
        } else {
            tier.postage
        },
        order_count: in_tier.len(),
        postage_order_count: postage.len(),
        basis: if learned {
            TierBasis::Observed
        } else {
            tier.basis
        },
    }
}

/// Shipping economics per tier and the baskets units sold in, from recent orders.
pub fn learn(
    orders: &[OrderEvidence],
    learned_at: &str,
    evidence_window_days: i64,
) -> ShippingCostModel {
    let baskets = orders
        .iter()
        .flat_map(|order| {
            order.lines.iter().flat_map(move |line| {
                let basket = BasketEvidence {
                    unit_price: line.unit_price,
                    other_items_value: round_currency(
                        (order.item_value - line.unit_price).max(0.0),
                    ),
                };
                std::iter::repeat_n(basket, line.quantity)
            })
        })
        .collect();
    let defaults = default_tiers();
    ShippingCostModel {
        learned_at: learned_at.to_string(),
        evidence_window_days,
        order_count: orders.len(),
        tiers: defaults
            .iter()
            .enumerate()
            .map(|(index, tier)| learn_tier(tier, defaults.get(index + 1), orders))
            .collect(),
        baskets,
    }
}

/// The tier an order of this value ships in, read by whole cents.
pub fn tier_for_order_value(tiers: &[ShippingTier], order_value: f64) -> &ShippingTier {
    let cents = to_cents(order_value);
    tiers
        .iter()
        .rev()
        .find(|tier| cents >= to_cents(tier.from_order_value))
        .unwrap_or(&tiers[0])
}

/// Postage less the buyer's shipping after fees, for one order; negative is income.
pub fn order_shipping_cost(tiers: &[ShippingTier], order_value: f64, overhead_rate: f64) -> f64 {
    if to_cents(order_value) <= 0 {
        return 0.0;
    }
    let tier = tier_for_order_value(tiers, order_value);
    tier.postage - tier.buyer_shipping * (1.0 - overhead_rate)
}

/// Baskets of units sold between half and twice the price. Buyers of cheap and expensive cards
/// order differently, so baskets far from the price are not used in place of missing nearby ones.
pub fn baskets_near(model: &ShippingCostModel, price: f64) -> Vec<BasketEvidence> {
    model
        .baskets
        .iter()
        .copied()
        .filter(|b| b.unit_price >= price / 2.0 && b.unit_price < price * 2.0)
        .collect()
}

/// Shipping cost one unit at this price adds to the orders it would join: the change in postage
/// less buyer shipping when it is added to each basket.
pub fn expected_shipping_cost(
    tiers: &[ShippingTier],
    baskets: &[BasketEvidence],
    price: f64,
    overhead_rate: f64,
) -> f64 {
    if baskets.is_empty() {
        return order_shipping_cost(tiers, price, overhead_rate);
    }
    let added: Vec<f64> = baskets
        .iter()
        .map(|b| {
            order_shipping_cost(tiers, b.other_items_value + price, overhead_rate)
                - order_shipping_cost(tiers, b.other_items_value, overhead_rate)
        })
        .collect();
    mean(&added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(
        item_value: f64,
        buyer_shipping: f64,
        postage: Option<f64>,
        unit_prices: &[f64],
    ) -> OrderEvidence {
        OrderEvidence {
            item_value,
            buyer_shipping: Some(buyer_shipping),
            postage,
            lines: unit_prices
                .iter()
                .enumerate()
                .map(|(index, &unit_price)| OrderLine {
                    sku: index as i64 + 1,
                    quantity: 1,
                    unit_price,
                })
                .collect(),
        }
    }

    fn model() -> ShippingCostModel {
        let mut orders = Vec::new();
        orders.extend(std::iter::repeat_n(
            order(3.0, 1.5, Some(0.7), &[3.0]),
            MINIMUM_TIER_ORDERS,
        ));
        orders.extend(std::iter::repeat_n(
            order(20.0, 0.0, Some(0.9), &[20.0]),
            MINIMUM_TIER_ORDERS,
        ));
        orders.extend(std::iter::repeat_n(
            order(60.0, 0.0, Some(6.0), &[60.0]),
            MINIMUM_TIER_ORDERS - 1,
        ));
        orders.push(order(60.0, 0.0, None, &[60.0]));
        learn(&orders, "2026-10-11T00:00:00Z", 90)
    }

    #[test]
    fn tiers_learn_from_recent_orders_and_keep_defaults_where_postage_evidence_is_short() {
        let model = model();
        let tiers: Vec<_> = model
            .tiers
            .iter()
            .map(|t| (t.from_order_value, t.buyer_shipping, t.postage, t.basis))
            .collect();
        assert_eq!(
            tiers,
            [
                (0.0, 1.5, 0.7, TierBasis::Observed),
                (5.0, 0.0, 0.9, TierBasis::Observed),
                (50.0, 0.0, 5.77, TierBasis::Default),
                (250.0, 0.0, 9.8, TierBasis::Default),
            ]
        );
        assert_eq!(model.tiers[2].order_count, MINIMUM_TIER_ORDERS);
        assert_eq!(model.tiers[2].postage_order_count, MINIMUM_TIER_ORDERS - 1);
    }

    #[test]
    fn order_shipping_cost_reads_the_tier_by_whole_cents_and_nets_buyer_shipping_after_fees() {
        let model = model();
        assert_eq!(
            tier_for_order_value(&model.tiers, 4.99).from_order_value,
            0.0
        );
        assert_eq!(
            tier_for_order_value(&model.tiers, 49.99 + 0.01).from_order_value,
            50.0
        );
        assert_eq!(order_shipping_cost(&model.tiers, 0.0, 0.15), 0.0);
        assert!((order_shipping_cost(&model.tiers, 4.99, 0.1) - (0.7 - 1.5 * 0.9)).abs() < 1e-9);
    }

    #[test]
    fn each_copy_sold_is_a_basket_and_only_nearby_prices_describe_a_thresholds_buyers() {
        let multi_copy = learn(
            &[OrderEvidence {
                lines: vec![OrderLine {
                    sku: 1,
                    quantity: 3,
                    unit_price: 5.0,
                }],
                ..order(15.0, 0.0, Some(0.9), &[])
            }],
            "x",
            30,
        );
        assert_eq!(
            multi_copy.baskets,
            vec![
                BasketEvidence {
                    unit_price: 5.0,
                    other_items_value: 10.0
                };
                3
            ]
        );
        let model = model();
        assert_eq!(baskets_near(&model, 50.0).len(), MINIMUM_TIER_ORDERS);
        assert!(
            baskets_near(&model, 50.0)
                .iter()
                .all(|b| b.unit_price == 60.0)
        );
        assert_eq!(baskets_near(&model, 500.0).len(), 0);
    }

    #[test]
    fn a_units_shipping_cost_is_what_it_adds_to_the_order_it_joins() {
        let tiers = model().tiers;
        let alone = [BasketEvidence {
            unit_price: 50.0,
            other_items_value: 0.0,
        }];
        let with_others = [BasketEvidence {
            unit_price: 50.0,
            other_items_value: 10.0,
        }];
        assert!((expected_shipping_cost(&tiers, &alone, 50.5, 0.15) - 5.77).abs() < 1e-9);
        assert!((expected_shipping_cost(&tiers, &alone, 49.99, 0.15) - 0.9).abs() < 1e-9);
        assert!(
            (expected_shipping_cost(&tiers, &with_others, 49.99, 0.15) - (5.77 - 0.9)).abs() < 1e-9
        );
        assert!(
            (expected_shipping_cost(&tiers, &with_others, 50.5, 0.15) - (5.77 - 0.9)).abs() < 1e-9
        );
    }
}
