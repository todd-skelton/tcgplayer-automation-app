//! Concrete changes ranked by how directly they move profit per day, each with the numbers that
//! justify it: `improvementLevers.ts`. The screen words them; this decides which apply.
use super::{dashboard::HurdleScenario, performance::PerformanceSummary};

/// A hurdle scenario and the daily return it models.
#[derive(Clone, Debug, PartialEq)]
pub struct Modeled<'a> {
    pub scenario: &'a HurdleScenario,
    pub daily_return: f64,
}

pub struct LeverInput<'a> {
    /// The hurdle the active policy prices at.
    pub configured_hurdle: f64,
    /// Highest modeled daily return on the ladder, and the configured one.
    pub best: Option<Modeled<'a>>,
    pub configured: Option<Modeled<'a>>,
    /// Realized performance over the window being shown.
    pub overall: Option<&'a PerformanceSummary>,
    pub product_lines: &'a [PerformanceSummary],
    /// Sale proceeds not yet republished, and how long the oldest has waited.
    pub waiting_cents: i64,
    pub oldest_waiting_days: Option<f64>,
    pub modeled_units: i64,
    pub total_units: i64,
}

/// What moving to the best hurdle changes against the configured one.
#[derive(Clone, Debug, PartialEq)]
pub struct HurdleChange {
    pub listed_value_dollars: f64,
    pub median_wait_days: f64,
}

/// A product line's realized return.
#[derive(Clone, Debug, PartialEq)]
pub struct LineReturn {
    pub product_line: String,
    pub daily_return_percent: f64,
    pub cost_cents: i64,
    pub average_days_held: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Lever {
    /// Move the hurdle to the one that models the best return.
    ChangeHurdle {
        raise: bool,
        to: f64,
        models: f64,
        configured_models: Option<f64>,
        change: Option<HurdleChange>,
    },
    /// Realized return on capital against the hurdle, in percent a day.
    BelowHurdle {
        realized_percent: f64,
        hurdle_percent: f64,
    },
    ClearingHurdle {
        realized_percent: f64,
        hurdle_percent: f64,
    },
    LinesBelowHurdle(Vec<LineReturn>),
    /// Lines returning at least twice the hurdle.
    LinesWellAboveHurdle(Vec<LineReturn>),
    ProceedsWaiting {
        cents: i64,
        oldest_days: Option<f64>,
    },
    UnforecastUnits {
        count: i64,
    },
}

/// Only lines with enough sales to say anything.
const MINIMUM_LINE_UNITS: i64 = 10;

fn line_return(line: &PerformanceSummary) -> Option<LineReturn> {
    Some(LineReturn {
        product_line: line.product_line.clone(),
        daily_return_percent: line.daily_return_percent?,
        cost_cents: line.cost_cents,
        average_days_held: line.average_days_held,
    })
}

/// The levers that stand out, most direct first; none when nothing does.
pub fn improvement_levers(input: &LeverInput) -> Vec<Lever> {
    let mut levers = Vec::new();
    let hurdle = input.configured_hurdle;
    let hurdle_percent = hurdle * 100.0;

    if let Some(best) = input.best.as_ref().filter(|best| !best.scenario.configured) {
        let scenario = best.scenario;
        let change = input.configured.as_ref().and_then(|configured| {
            let (now, then) = (
                configured.scenario.summary.estimated_time?,
                scenario.summary.estimated_time?,
            );
            Some(HurdleChange {
                listed_value_dollars: scenario.summary.physical_value
                    - configured.scenario.summary.physical_value,
                median_wait_days: then.median_days - now.median_days,
            })
        });
        levers.push(Lever::ChangeHurdle {
            raise: scenario.daily_return_hurdle > hurdle,
            to: scenario.daily_return_hurdle,
            models: best.daily_return,
            configured_models: input.configured.as_ref().map(|c| c.daily_return),
            change,
        });
    }

    if let Some(overall) = input
        .overall
        .filter(|o| o.included_units >= MINIMUM_LINE_UNITS)
        && let Some(realized_percent) = overall.daily_return_percent
    {
        levers.push(if realized_percent < hurdle_percent {
            Lever::BelowHurdle {
                realized_percent,
                hurdle_percent,
            }
        } else {
            Lever::ClearingHurdle {
                realized_percent,
                hurdle_percent,
            }
        });
    }

    let lines_where = |keep: &dyn Fn(f64) -> bool| -> Vec<LineReturn> {
        input
            .product_lines
            .iter()
            .filter(|line| line.included_units >= MINIMUM_LINE_UNITS)
            .filter_map(line_return)
            .filter(|line| keep(line.daily_return_percent))
            .collect()
    };
    let laggards = lines_where(&|percent| percent < hurdle_percent);
    if !laggards.is_empty() {
        levers.push(Lever::LinesBelowHurdle(laggards));
    }
    let leaders = lines_where(&|percent| percent >= hurdle_percent * 2.0);
    if !leaders.is_empty() {
        levers.push(Lever::LinesWellAboveHurdle(leaders));
    }

    if input.waiting_cents > 0 {
        levers.push(Lever::ProceedsWaiting {
            cents: input.waiting_cents,
            oldest_days: input.oldest_waiting_days,
        });
    }

    if input.total_units > 0 && (input.modeled_units as f64 / input.total_units as f64) < 0.9 {
        levers.push(Lever::UnforecastUnits {
            count: input.total_units - input.modeled_units,
        });
    }
    levers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::inventory_strategy::verdict::tests::scenario;

    fn summary(product_line: &str, daily_return_percent: Option<f64>) -> PerformanceSummary {
        PerformanceSummary {
            product_line: product_line.into(),
            units_sold: 50,
            included_units: 50,
            gross_cents: 125_000,
            included_gross_cents: 125_000,
            proceeds_cents: 100_000,
            cost_cents: 75_000,
            profit_cents: 25_000,
            margin_percent: Some(25.0),
            markup_percent: Some(33.0),
            profit_per_day_cents: Some(800.0),
            daily_return_percent,
            average_days_held: Some(12.0),
        }
    }

    #[test]
    fn levers_name_the_hurdle_realized_return_product_lines_idle_cash_and_coverage() {
        let best = scenario(0.015, 19_000.0, Some(6.0), false);
        let configured = scenario(0.005, 20_100.0, Some(21.0), true);
        let overall = summary("All", Some(1.2));
        let lines = [
            PerformanceSummary {
                cost_cents: 60_000,
                ..summary("Pokemon", Some(1.4))
            },
            PerformanceSummary {
                cost_cents: 5_000,
                average_days_held: Some(40.0),
                ..summary("YuGiOh", Some(0.2))
            },
            PerformanceSummary {
                included_units: 3,
                ..summary("Sparse", Some(0.1))
            },
        ];
        let levers = improvement_levers(&LeverInput {
            configured_hurdle: 0.005,
            best: Some(Modeled {
                scenario: &best,
                daily_return: 0.0058,
            }),
            configured: Some(Modeled {
                scenario: &configured,
                daily_return: 0.0051,
            }),
            overall: Some(&overall),
            product_lines: &lines,
            waiting_cents: 12_345,
            oldest_waiting_days: Some(9.0),
            modeled_units: 800,
            total_units: 1000,
        });
        assert_eq!(levers.len(), 6);
        let Lever::ChangeHurdle {
            raise,
            to,
            models,
            configured_models,
            change: Some(change),
        } = &levers[0]
        else {
            panic!("the hurdle lever first, with what it changes");
        };
        assert_eq!(
            (*raise, *to, *models, *configured_models),
            (true, 0.015, 0.0058, Some(0.0051))
        );
        assert_eq!(
            (change.listed_value_dollars, change.median_wait_days),
            (-1_100.0, -15.0)
        );
        assert_eq!(
            levers[1],
            Lever::ClearingHurdle {
                realized_percent: 1.2,
                hurdle_percent: 0.5
            }
        );
        let Lever::LinesBelowHurdle(laggards) = &levers[2] else {
            panic!("lines below the hurdle")
        };
        assert_eq!(
            laggards,
            &[LineReturn {
                product_line: "YuGiOh".into(),
                daily_return_percent: 0.2,
                cost_cents: 5_000,
                average_days_held: Some(40.0)
            }]
        );
        let Lever::LinesWellAboveHurdle(leaders) = &levers[3] else {
            panic!("lines well above the hurdle")
        };
        assert_eq!(
            leaders
                .iter()
                .map(|l| l.product_line.as_str())
                .collect::<Vec<_>>(),
            ["Pokemon"]
        );
        assert_eq!(
            levers[4],
            Lever::ProceedsWaiting {
                cents: 12_345,
                oldest_days: Some(9.0)
            }
        );
        assert_eq!(levers[5], Lever::UnforecastUnits { count: 200 });

        let quiet_overall = summary("All", Some(0.3));
        let quiet = improvement_levers(&LeverInput {
            configured_hurdle: 0.005,
            best: Some(Modeled {
                scenario: &configured,
                daily_return: 0.0051,
            }),
            configured: Some(Modeled {
                scenario: &configured,
                daily_return: 0.0051,
            }),
            overall: Some(&quiet_overall),
            product_lines: &[],
            waiting_cents: 0,
            oldest_waiting_days: None,
            modeled_units: 950,
            total_units: 1000,
        });
        assert_eq!(
            quiet,
            [Lever::BelowHurdle {
                realized_percent: 0.3,
                hurdle_percent: 0.5
            }]
        );

        let nothing = improvement_levers(&LeverInput {
            configured_hurdle: 0.005,
            best: None,
            configured: None,
            overall: None,
            product_lines: &[],
            waiting_cents: 0,
            oldest_waiting_days: None,
            modeled_units: 0,
            total_units: 0,
        });
        assert!(nothing.is_empty());
    }
}
