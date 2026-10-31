//! What selling at a horizon earns on the capital it ties up: `capitalCycle.ts`. A cycle sells at
//! the modeled value, pays overhead, recovers the cost basis, and waits out the turnaround before
//! the money is working again.
use crate::js_math::JsMath;
use serde::Serialize;

use super::{
    horizon_value_curve::{HorizonValueCurve, log_spaced_horizons},
    maximize::maximize_over_candidates,
};

/// Seller economics that turn sale value at a horizon into return on capital.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Economics {
    /// Cost basis as a share of market value.
    pub cost_basis_share_of_market: f64,
    /// Dollars off the cost basis for every unit bought, as when a lot is priced at a share of
    /// market less an allowance per card. Bulk the seller was paid to take can make the cost
    /// basis negative.
    pub cost_basis_discount_per_unit: f64,
    /// Overhead as a fraction of sale value.
    pub relative_overhead: f64,
    /// Overhead in dollars per unit sold.
    pub static_overhead_per_unit: f64,
    /// Days from a sale until the proceeds are relisted as new inventory.
    pub turnaround_days: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Portfolio {
    pub market_value: f64,
    pub unit_count: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapitalCycle {
    pub horizon_days: f64,
    pub net_proceeds: f64,
    pub profit: f64,
    pub cycle_days: f64,
    pub profit_per_day: f64,
    /// Continuous rate per cycle day at which the cycle grows its capital; None when no capital
    /// is at risk, nothing comes back, or the cycle takes no time.
    pub daily_return: Option<f64>,
}

/// The horizons a best cycle is looked for between.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HorizonRange {
    pub minimum_horizon_days: f64,
    pub maximum_horizon_days: f64,
}

const BEST_CYCLE_GRID_COUNT: usize = 128;

/// One cycle that sells the portfolio for a value after a wait.
pub fn capital_cycle(
    sale_value: f64,
    horizon_days: f64,
    portfolio: Portfolio,
    economics: Economics,
) -> CapitalCycle {
    let net_proceeds = sale_value * (1.0 - economics.relative_overhead)
        - economics.static_overhead_per_unit * portfolio.unit_count;
    let cost = economics.cost_basis_share_of_market * portfolio.market_value
        - economics.cost_basis_discount_per_unit * portfolio.unit_count;
    let profit = net_proceeds - cost;
    let cycle_days = horizon_days + economics.turnaround_days;
    CapitalCycle {
        horizon_days,
        net_proceeds,
        profit,
        cycle_days,
        profit_per_day: if cycle_days > 0.0 {
            profit / cycle_days
        } else {
            0.0
        },
        daily_return: (cycle_days > 0.0 && cost > 0.0 && net_proceeds > 0.0)
            .then(|| (net_proceeds / cost).js_ln() / cycle_days),
    }
}

/// One cycle at a target horizon, selling at the curve's value there.
pub fn capital_cycle_at_horizon(
    curve: &HorizonValueCurve,
    portfolio: Portfolio,
    economics: Economics,
    horizon_days: f64,
) -> CapitalCycle {
    capital_cycle(
        curve.value(horizon_days),
        horizon_days,
        portfolio,
        economics,
    )
}

/// The cycle with the most profit per day within the range, or None when no horizon in the range
/// turns a profit.
pub fn best_capital_cycle(
    curve: &HorizonValueCurve,
    portfolio: Portfolio,
    economics: Economics,
    range: HorizonRange,
) -> Option<CapitalCycle> {
    let horizons = log_spaced_horizons(
        range.minimum_horizon_days,
        range.maximum_horizon_days,
        BEST_CYCLE_GRID_COUNT,
    );
    let best = maximize_over_candidates(&horizons, |horizon_days| {
        capital_cycle_at_horizon(curve, portfolio, economics, horizon_days).profit_per_day
    })?;
    (best.value > 0.0).then(|| capital_cycle_at_horizon(curve, portfolio, economics, best.argument))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURVE: HorizonValueCurve = HorizonValueCurve {
        floor_value: 23_962.0,
        ceiling_value: 32_737.0,
        midpoint_days: 20.0,
        steepness: 0.97,
        residual: 0.02,
    };
    const PORTFOLIO: Portfolio = Portfolio {
        market_value: 24_542.0,
        unit_count: 1_929.0,
    };
    const ECONOMICS: Economics = Economics {
        cost_basis_share_of_market: 0.725,
        cost_basis_discount_per_unit: 0.0,
        relative_overhead: 0.15,
        static_overhead_per_unit: 0.3,
        turnaround_days: 28.0,
    };
    const RANGE: HorizonRange = HorizonRange {
        minimum_horizon_days: 0.1,
        maximum_horizon_days: 100_000.0,
    };

    fn at(economics: Economics, horizon_days: f64) -> CapitalCycle {
        capital_cycle_at_horizon(&CURVE, PORTFOLIO, economics, horizon_days)
    }

    #[test]
    fn values_a_horizon_by_profit_per_day_of_cycle() {
        let cost = ECONOMICS.cost_basis_share_of_market * PORTFOLIO.market_value;
        let cycle = at(ECONOMICS, 24.0);
        assert_eq!(
            cycle,
            capital_cycle(CURVE.value(24.0), 24.0, PORTFOLIO, ECONOMICS),
            "a cycle at a horizon sells at the curve's value there"
        );
        assert!(
            (cycle.net_proceeds
                - (CURVE.value(24.0) * (1.0 - ECONOMICS.relative_overhead)
                    - ECONOMICS.static_overhead_per_unit * PORTFOLIO.unit_count))
                .abs()
                < 1e-9,
            "net proceeds take relative overhead off the sale and static overhead per unit"
        );
        assert!((cycle.profit - (cycle.net_proceeds - cost)).abs() < 1e-9);
        assert_eq!(cycle.cycle_days, 24.0 + ECONOMICS.turnaround_days);
        assert!((cycle.profit_per_day - cycle.profit / cycle.cycle_days).abs() < 1e-9);
        let daily_return = cycle.daily_return.unwrap();
        assert!(
            (daily_return - (cycle.net_proceeds / cost).js_ln() / cycle.cycle_days).abs() < 1e-12,
            "daily return is the continuous growth of the cost basis over the cycle"
        );

        let discounted = at(
            Economics {
                cost_basis_discount_per_unit: 0.3,
                ..ECONOMICS
            },
            24.0,
        );
        assert!(
            (discounted.profit - (cycle.profit + 0.3 * PORTFOLIO.unit_count)).abs() < 1e-9,
            "the cost basis discount comes off per unit bought"
        );
        assert_eq!(discounted.net_proceeds, cycle.net_proceeds);
        let paid_to_take = at(
            Economics {
                cost_basis_discount_per_unit: 20.0,
                ..ECONOMICS
            },
            24.0,
        );
        assert!(
            paid_to_take.profit > paid_to_take.net_proceeds,
            "a discount beyond the share makes the cost basis negative"
        );
        assert_eq!(
            paid_to_take.daily_return, None,
            "no capital at risk means no rate of return"
        );
        assert_eq!(
            at(
                Economics {
                    static_overhead_per_unit: 100.0,
                    ..ECONOMICS
                },
                24.0
            )
            .daily_return,
            None,
            "a cycle that brings nothing back has no rate of return"
        );

        let optimum = best_capital_cycle(&CURVE, PORTFOLIO, ECONOMICS, RANGE).unwrap();
        assert!(
            optimum.horizon_days > 12.0 && optimum.horizon_days < 20.0,
            "a four-week turnaround puts the best cycle in the mid teens, got {}",
            optimum.horizon_days
        );
        assert_eq!(
            optimum,
            at(ECONOMICS, optimum.horizon_days),
            "the best cycle is the cycle at its horizon"
        );
        let step = 1e-3;
        let slope = (at(ECONOMICS, optimum.horizon_days + step).profit_per_day
            - at(ECONOMICS, optimum.horizon_days - step).profit_per_day)
            / (2.0 * step);
        assert!(
            slope.abs() < 1e-3,
            "profit per day is flat at the optimum, slope {slope}"
        );

        let fast_turnaround = best_capital_cycle(
            &CURVE,
            PORTFOLIO,
            Economics {
                turnaround_days: 0.0,
                ..ECONOMICS
            },
            RANGE,
        )
        .unwrap();
        assert!(
            fast_turnaround.horizon_days < 0.2,
            "with no turnaround and a deep discount the best cycle is the fastest sale"
        );
        let slow_turnaround = best_capital_cycle(
            &CURVE,
            PORTFOLIO,
            Economics {
                turnaround_days: 90.0,
                ..ECONOMICS
            },
            RANGE,
        );
        assert!(
            slow_turnaround.map_or(0.0, |c| c.horizon_days) > optimum.horizon_days,
            "a longer turnaround pushes the best cycle out"
        );
        assert_eq!(
            best_capital_cycle(
                &CURVE,
                PORTFOLIO,
                Economics {
                    cost_basis_share_of_market: 1.5,
                    ..ECONOMICS
                },
                RANGE
            ),
            None,
            "no best cycle when every horizon loses money"
        );
    }
}
