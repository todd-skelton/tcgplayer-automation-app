//! Listing one cent under a shipping threshold when that returns more: `shippingThresholdSnap.ts`.
use crate::features::{
    inventory_economics::ledger::assumptions::js_round,
    shipping_thresholds::{
        ShippingThresholdSnap, SnapOutcome, SnapPolicy,
        cost_model::{MINIMUM_NEARBY_BASKETS, baskets_near, expected_shipping_cost},
    },
};

pub struct SnapInputs<'a> {
    /// Price the policy chose, after the floor.
    pub policy_price: f64,
    pub snap: &'a SnapPolicy,
    pub daily_return_hurdle: f64,
    /// Share of each sale, buyer shipping included, lost to fees.
    pub overhead_rate: f64,
    /// Net proceeds at a price before shipping.
    pub net_proceeds: &'a dyn Fn(f64) -> f64,
    /// Expected median sell time at a price, when the curve forecasts one.
    pub sell_days: &'a dyn Fn(f64) -> Option<f64>,
    /// False when a price is below the floor.
    pub allowed: &'a dyn Fn(f64) -> bool,
}

fn round_currency(value: f64) -> f64 {
    js_round(value * 100.0) as f64 / 100.0
}

/// The highest threshold the price sits at or within the snap range above.
pub fn threshold_to_snap_under(price: f64, thresholds: &[f64], snap_range: f64) -> Option<f64> {
    let mut descending = thresholds.to_vec();
    descending.sort_by(|left, right| right.partial_cmp(left).unwrap_or(std::cmp::Ordering::Equal));
    descending
        .into_iter()
        .find(|&threshold| price >= threshold && price <= threshold * (1.0 + snap_range))
}

/// Compares the policy price with one cent under the threshold it sits just above. Each price is
/// valued as net proceeds after its expected shipping cost, discounted at the hurdle over its
/// forecast sell time. Nothing is considered when the price is not near a threshold, either price
/// lacks a forecast, or too few units sold near the threshold to know what buyers order alongside.
pub fn consider(inputs: &SnapInputs) -> Option<ShippingThresholdSnap> {
    let snap = inputs.snap;
    let threshold =
        threshold_to_snap_under(inputs.policy_price, &snap.thresholds, snap.snap_range)?;
    let snap_price = round_currency(threshold - 0.01);
    let policy_days = (inputs.sell_days)(inputs.policy_price)?;
    let snap_days = (inputs.sell_days)(snap_price)?;

    let baskets = baskets_near(&snap.cost_model, threshold);
    if baskets.len() < MINIMUM_NEARBY_BASKETS {
        return None;
    }
    let shipping_cost = |price: f64| {
        expected_shipping_cost(
            &snap.cost_model.tiers,
            &baskets,
            price,
            inputs.overhead_rate,
        )
    };
    let discounted_return = |price: f64, days: f64| {
        let net = (inputs.net_proceeds)(price) - shipping_cost(price);
        if net > 0.0 {
            net * (-inputs.daily_return_hurdle * days).exp()
        } else {
            net
        }
    };
    let policy_price_return = discounted_return(inputs.policy_price, policy_days);
    let snap_price_return = discounted_return(snap_price, snap_days);
    Some(ShippingThresholdSnap {
        threshold,
        outcome: if !(inputs.allowed)(snap_price) {
            SnapOutcome::Floor
        } else if snap_price_return > policy_price_return {
            SnapOutcome::Snapped
        } else {
            SnapOutcome::Kept
        },
        policy_price: inputs.policy_price,
        snap_price,
        policy_price_shipping_cost: round_currency(shipping_cost(inputs.policy_price)),
        snap_price_shipping_cost: round_currency(shipping_cost(snap_price)),
        policy_price_return: round_currency(policy_price_return),
        snap_price_return: round_currency(snap_price_return),
        cost_model_learned_at: snap.cost_model.learned_at.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{
        pricing::policy::{
            Constrained, Constraint, Curve, CurvePoint, Policy, ProfitPerDay, SupplyStatus,
            select_decision,
        },
        shipping_thresholds::{BasketEvidence, ShippingCostModel, cost_model::default_tiers},
    };

    fn point(percentile: f64, price: f64, days: f64) -> CurvePoint {
        CurvePoint {
            percentile,
            price,
            estimated_median_sell_days: Some(days),
            supply_status: Some(SupplyStatus::Observed),
            ..CurvePoint::default()
        }
    }

    /// The best return sits just above $50: cheaper barely sells faster, dearer waits far longer.
    fn curve() -> Curve {
        Curve::new(vec![
            point(10.0, 49.0, 10.0),
            point(50.0, 50.5, 10.1),
            point(90.0, 60.0, 200.0),
        ])
    }

    fn model(other_items_value: f64, count: usize) -> ShippingCostModel {
        ShippingCostModel {
            learned_at: "2026-10-11T00:00:00.000Z".into(),
            evidence_window_days: 90,
            order_count: count,
            tiers: default_tiers(),
            baskets: vec![
                BasketEvidence {
                    unit_price: 50.0,
                    other_items_value
                };
                count
            ],
        }
    }

    fn policy(cost_model: Option<ShippingCostModel>) -> Policy {
        Policy::ProfitPerDay(ProfitPerDay {
            daily_return_hurdle: 0.005,
            relative_overhead: 0.15,
            static_overhead_per_unit: 0.0,
            shipping_threshold_snap: cost_model.map(|cost_model| SnapPolicy {
                thresholds: vec![5.0, 50.0, 250.0],
                snap_range: 0.1,
                cost_model,
            }),
        })
    }

    fn none(price: f64) -> Constrained {
        Constrained {
            price,
            constraint: Constraint::Unconstrained,
        }
    }

    #[test]
    fn only_prices_from_a_threshold_to_the_top_of_its_snap_range_are_considered() {
        let all = [5.0, 50.0, 250.0];
        assert_eq!(threshold_to_snap_under(50.0, &all, 0.1), Some(50.0));
        assert_eq!(threshold_to_snap_under(55.0, &all, 0.1), Some(50.0));
        assert_eq!(threshold_to_snap_under(55.01, &all, 0.1), None);
        assert_eq!(threshold_to_snap_under(49.99, &all, 0.1), None);
        assert_eq!(threshold_to_snap_under(5.2, &[50.0], 0.1), None);
    }

    #[test]
    fn a_snap_is_taken_when_it_returns_more_and_recorded_either_way() {
        let unconstrained: &dyn Fn(f64) -> Constrained = &none;
        let unsnapped =
            select_decision(&curve(), &policy(None), None, Some(unconstrained)).unwrap();
        assert!(unsnapped.selected_price >= 50.0 && unsnapped.selected_price <= 55.0);
        assert_eq!(unsnapped.shipping_threshold_snap, None);

        let snapped = select_decision(
            &curve(),
            &policy(Some(model(0.0, 20))),
            None,
            Some(unconstrained),
        )
        .unwrap();
        let snap = snapped.shipping_threshold_snap.clone().unwrap();
        assert_eq!(
            snapped.selected_price, 49.99,
            "a lone-card buyer's tracked postage makes $49.99 return more"
        );
        assert_eq!(snapped.unconstrained_price, unsnapped.unconstrained_price);
        assert_eq!(
            (snap.outcome, snap.policy_price),
            (SnapOutcome::Snapped, unsnapped.selected_price)
        );
        assert_eq!(
            (
                snap.snap_price_shipping_cost,
                snap.policy_price_shipping_cost
            ),
            (0.83, 5.77)
        );
        assert!(snapped.estimated_median_sell_days < unsnapped.estimated_median_sell_days);

        let kept = select_decision(
            &curve(),
            &policy(Some(model(100.0, 20))),
            None,
            Some(unconstrained),
        )
        .unwrap();
        let kept_snap = kept.shipping_threshold_snap.unwrap();
        assert_eq!(
            (kept.selected_price, kept_snap.outcome),
            (unsnapped.selected_price, SnapOutcome::Kept)
        );
        assert!(
            kept_snap.policy_price_return > kept_snap.snap_price_return,
            "other items cross the threshold anyway"
        );

        let floor = |price: f64| {
            if price < 50.2 {
                Constrained {
                    price: 50.2,
                    constraint: Constraint::Floor,
                }
            } else {
                none(price)
            }
        };
        let floored =
            select_decision(&curve(), &policy(Some(model(0.0, 20))), None, Some(&floor)).unwrap();
        assert_eq!(floored.selected_price, unsnapped.selected_price);
        assert_eq!(
            floored.shipping_threshold_snap.unwrap().outcome,
            SnapOutcome::Floor,
            "a snap never lists under the floor"
        );
    }

    #[test]
    fn snaps_need_nearby_sales_a_forecast_and_the_profit_per_day_policy() {
        let unconstrained: &dyn Fn(f64) -> Constrained = &none;
        let thin = select_decision(
            &curve(),
            &policy(Some(model(0.0, 19))),
            None,
            Some(unconstrained),
        )
        .unwrap();
        assert_eq!(thin.shipping_threshold_snap, None);
        let unforecast = Curve::new(
            curve()
                .points()
                .iter()
                .map(|p| CurvePoint {
                    supply_status: Some(SupplyStatus::Unavailable),
                    ..p.clone()
                })
                .collect(),
        );
        let unforecast = select_decision(
            &unforecast,
            &policy(Some(model(0.0, 20))),
            None,
            Some(unconstrained),
        );
        assert_eq!(unforecast.and_then(|d| d.shipping_threshold_snap), None);
        let percentile = select_decision(
            &curve(),
            &Policy::Percentile { percentile: 50.0 },
            None,
            Some(unconstrained),
        )
        .unwrap();
        assert_eq!(percentile.shipping_threshold_snap, None);
    }
}
