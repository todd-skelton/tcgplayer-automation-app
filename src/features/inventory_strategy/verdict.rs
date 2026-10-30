//! Which daily return hurdle turns capital over fastest: each hurdle's portfolio, sold for its
//! value after its median wait, valued as a capital cycle. Ported from `components/verdict.ts`.
use super::dashboard::HurdleScenario;
use crate::features::{
    inventory_intake::queue::CostRate,
    pricing::capital_cycle::{Economics, Portfolio, capital_cycle},
};

/// The cost basis the strategy assumes: the default rule that estimates purchase costs, not any
/// batch's own rate. Returns (share of market, dollars off per unit).
pub fn strategy_cost_basis() -> (f64, f64) {
    (
        CostRate::DEFAULT.market_rate,
        CostRate::DEFAULT.per_unit_deduction_cents as f64 / 100.0,
    )
}

/// Economics at the strategy's cost basis with the seller's overhead and turnaround.
pub fn strategy_economics(
    relative_overhead: f64,
    static_overhead_per_unit: f64,
    turnaround_days: f64,
) -> Economics {
    let (cost_basis_share_of_market, cost_basis_discount_per_unit) = strategy_cost_basis();
    Economics {
        cost_basis_share_of_market,
        cost_basis_discount_per_unit,
        relative_overhead,
        static_overhead_per_unit,
        turnaround_days,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HurdleReturn<'a> {
    pub scenario: &'a HurdleScenario,
    /// Continuous daily growth of the cost basis over the cycle the hurdle implies.
    pub daily_return: f64,
}

/// The hurdles whose cycle grows capital, best first; one without a wait or that loses money is
/// left out.
pub fn hurdle_returns<'a>(
    sweep: &'a [HurdleScenario],
    portfolio: Portfolio,
    economics: Economics,
) -> Vec<HurdleReturn<'a>> {
    let mut returns: Vec<HurdleReturn> = sweep
        .iter()
        .filter_map(|scenario| {
            let time = scenario.summary.estimated_time?;
            let daily_return = capital_cycle(
                scenario.summary.physical_value,
                time.median_days,
                portfolio,
                economics,
            )
            .daily_return?;
            (daily_return > 0.0).then_some(HurdleReturn {
                scenario,
                daily_return,
            })
        })
        .collect();
    returns.sort_by(|left, right| {
        right
            .daily_return
            .partial_cmp(&left.daily_return)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    returns
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::features::inventory_strategy::dashboard::{DecisionSummary, TimeDistribution};

    pub fn scenario(
        daily_return_hurdle: f64,
        physical_value: f64,
        median_days: Option<f64>,
        configured: bool,
    ) -> HurdleScenario {
        HurdleScenario {
            summary: DecisionSummary {
                one_copy_value: physical_value,
                physical_value,
                modeled_sku_count: 1,
                raised_count: 0,
                lowered_count: 0,
                held_count: 0,
                estimated_time: median_days.map(|median_days| TimeDistribution {
                    median_days,
                    p75_days: median_days * 2.0,
                    p90_days: median_days * 3.0,
                }),
            },
            daily_return_hurdle,
            configured,
        }
    }

    #[test]
    fn hurdles_rank_by_cycle_return() {
        let economics = Economics {
            cost_basis_share_of_market: 0.5,
            cost_basis_discount_per_unit: 0.0,
            relative_overhead: 0.0,
            static_overhead_per_unit: 0.0,
            turnaround_days: 0.0,
        };
        let sweep = [
            scenario(0.0025, 200.0, Some(100.0), false),
            scenario(0.005, 180.0, Some(40.0), true),
            scenario(0.01, 150.0, Some(10.0), false),
            scenario(0.02, 40.0, Some(1.0), false),
            scenario(0.03, 120.0, None, false),
        ];
        let returns = hurdle_returns(
            &sweep,
            Portfolio {
                market_value: 200.0,
                unit_count: 1.0,
            },
            economics,
        );
        assert_eq!(
            returns
                .iter()
                .map(|r| r.scenario.daily_return_hurdle)
                .collect::<Vec<_>>(),
            [0.01, 0.005, 0.0025],
            "one that loses money or has no wait drops out"
        );
        assert!((returns[0].daily_return - (150.0f64 / 100.0).ln() / 10.0).abs() < 1e-12);
        assert_eq!(
            strategy_cost_basis(),
            (0.75, 0.3),
            "the strategy cost basis follows the estimated purchase cost rule"
        );
    }
}
