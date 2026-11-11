//! A sale rate shrunk toward its product line's: the Gamma-Poisson posterior mean
//! `(alpha + sales) / (beta + exposure days)`, its Gamma prior a week of the line's pooled rate,
//! so a thin history leans on the line and a long one speaks for itself. The pooled rate is the
//! line's stored recent results (`super::product_line_pools`), or the run's own results in the line
//! when none are stored. Recorded beside the other sell-time forecasts to be graded
//! (`features::forecast_calibration`); pricing does not read it.
use std::collections::HashMap;

use serde::Serialize;

use super::policy::median_sell_days;

pub const METHOD: &str = "gamma-poisson-v1";
/// Days of the pooled rate the prior is worth (its `beta`): a week, so a few weeks of a SKU's own
/// sales outweigh it.
pub const PRIOR_DAYS: f64 = 7.0;

/// Sales seen over the days they could have happened in.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Exposure {
    pub sales: f64,
    pub days: f64,
}

impl Exposure {
    /// The evidence behind a measured interval: `sales` sales, one per interval. Read this way a
    /// rate keeps its value and weighs as much as the sales it was measured from.
    pub fn of_interval(sales: Option<f64>, interval_days: Option<f64>) -> Option<Exposure> {
        let positive = |v: Option<f64>| v.filter(|v| v.is_finite() && *v > 0.0);
        let sales = positive(sales)?;
        Some(Exposure {
            sales,
            days: sales * positive(interval_days)?,
        })
    }

    pub fn plus(self, other: Exposure) -> Exposure {
        Exposure {
            sales: self.sales + other.sales,
            days: self.days + other.days,
        }
    }

    /// Sales per day, when there are both.
    fn rate(self) -> Option<f64> {
        (self.sales > 0.0 && self.days > 0.0).then(|| self.sales / self.days)
    }
}

/// The posterior mean daily sale rate of `evidence` under a Gamma prior whose mean is
/// `pooled_rate` and whose weight is `prior_days` of it; none for inputs that are not rates.
pub fn shrunk_rate(evidence: Exposure, pooled_rate: f64, prior_days: f64) -> Option<f64> {
    let counted = |v: f64| v.is_finite() && v >= 0.0;
    let positive = |v: f64| v.is_finite() && v > 0.0;
    if !(counted(evidence.sales)
        && counted(evidence.days)
        && positive(pooled_rate)
        && positive(prior_days))
    {
        return None;
    }
    let (alpha, beta) = (pooled_rate * prior_days, prior_days);
    Some((alpha + evidence.sales) / (beta + evidence.days))
}

/// A product line's sales over their exposure days, for buyer arrival and the condition rate.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pool {
    pub buyer_arrival: Exposure,
    pub condition_rate: Exposure,
}

impl Pool {
    fn plus(self, other: Pool) -> Pool {
        Pool {
            buyer_arrival: self.buyer_arrival.plus(other.buyer_arrival),
            condition_rate: self.condition_rate.plus(other.condition_rate),
        }
    }
}

/// Each product line's pool, by product line id.
pub type Pools = HashMap<i64, Pool>;

/// Where a pooled rate came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PoolSource {
    /// The product line's stored recent modeled results.
    Stored,
    /// The run's own results in the product line, when none are stored.
    Run,
}

/// One rate, shrunk, and the median wait it forecasts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrunkRate {
    pub sales: f64,
    pub exposure_days: f64,
    /// Days between sales across the product line's pool: the prior's mean.
    pub pooled_interval_days: f64,
    pub pool_source: PoolSource,
    /// Days between sales once shrunk toward the pooled rate.
    pub interval_days: f64,
    pub median_sell_days: f64,
}

/// The shrunk forecast of one modeled result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub method: &'static str,
    pub prior_days: f64,
    /// The curve's buyer arrival at the listed price, shrunk: this forecast's days to sell.
    #[serde(flatten)]
    pub buyer_arrival: ShrunkRate,
    /// The listed condition's own sale rate, shrunk the same way so the two compare.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_rate: Option<ShrunkRate>,
}

/// What one modeled result's forecast is shrunk from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Evidence {
    pub product_line_id: i64,
    /// The share of buyers the store wins at the listed price.
    pub store_win_share: Option<f64>,
    /// Buyers paying at least the listed price.
    pub buyer_arrival: Option<Exposure>,
    /// Sales of the listed condition.
    pub condition_rate: Option<Exposure>,
}

/// The stored pool's rate, or the run's when the line has no stored rate.
fn pooled_rate(stored: Option<Exposure>, run: Exposure) -> Option<(f64, PoolSource)> {
    stored
        .and_then(Exposure::rate)
        .map(|rate| (rate, PoolSource::Stored))
        .or_else(|| run.rate().map(|rate| (rate, PoolSource::Run)))
}

fn shrink(
    evidence: Exposure,
    (pooled_rate, pool_source): (f64, PoolSource),
    store_win_share: Option<f64>,
) -> Option<ShrunkRate> {
    let interval_days = 1.0 / shrunk_rate(evidence, pooled_rate, PRIOR_DAYS)?;
    Some(ShrunkRate {
        sales: evidence.sales,
        exposure_days: evidence.days,
        pooled_interval_days: 1.0 / pooled_rate,
        pool_source,
        interval_days,
        median_sell_days: median_sell_days(Some(interval_days), store_win_share, None)?,
    })
}

/// Each result's forecast, its prior the product line's `stored` pool, or else the line's results
/// in this run pooled: their sales over their days, so each SKU weighs as its evidence does.
pub fn forecasts(evidence: &[Evidence], stored: &Pools) -> Vec<Option<Forecast>> {
    let mut run: Pools = HashMap::new();
    for e in evidence {
        let pool = run.entry(e.product_line_id).or_default();
        *pool = pool.plus(Pool {
            buyer_arrival: e.buyer_arrival.unwrap_or_default(),
            condition_rate: e.condition_rate.unwrap_or_default(),
        });
    }
    evidence
        .iter()
        .map(|e| {
            let line = stored.get(&e.product_line_id);
            let run = run[&e.product_line_id];
            let arrival = pooled_rate(line.map(|p| p.buyer_arrival), run.buyer_arrival)?;
            let condition = pooled_rate(line.map(|p| p.condition_rate), run.condition_rate);
            Some(Forecast {
                method: METHOD,
                prior_days: PRIOR_DAYS,
                buyer_arrival: shrink(e.buyer_arrival?, arrival, e.store_win_share)?,
                condition_rate: e
                    .condition_rate
                    .zip(condition)
                    .and_then(|(seen, pooled)| shrink(seen, pooled, e.store_win_share)),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::f64::consts::LN_2;

    use super::*;

    fn seen(sales: f64, days: f64) -> Exposure {
        Exposure { sales, days }
    }

    #[test]
    fn a_thin_history_leans_on_the_pooled_rate() {
        // One sale in ten days against a line selling once in twenty.
        let shrunk = shrunk_rate(seen(1.0, 10.0), 0.05, PRIOR_DAYS).unwrap();
        assert!((shrunk - (0.05 * 7.0 + 1.0) / 17.0).abs() < 1e-12);
        assert!(shrunk < 0.1 && shrunk > 0.05, "{shrunk}");
        // The prior pulls a fast thin rate down and a slow one up.
        let slow = shrunk_rate(seen(1.0, 100.0), 0.05, PRIOR_DAYS).unwrap();
        assert!(slow > 0.01 && slow < 0.05, "{slow}");
    }

    #[test]
    fn evidence_overwhelms_the_prior_as_it_grows() {
        let raw = 0.1;
        let gaps: Vec<f64> = [1.0, 10.0, 100.0, 1000.0]
            .map(|sales| {
                (shrunk_rate(seen(sales, sales / raw), 0.05, PRIOR_DAYS).unwrap() - raw).abs()
            })
            .to_vec();
        assert!(gaps.windows(2).all(|w| w[1] < w[0]), "{gaps:?}");
        assert!(gaps[3] / raw < 0.001, "{gaps:?}");
    }

    #[test]
    fn no_sales_still_forecast_from_the_prior() {
        let none_seen = shrunk_rate(seen(0.0, 90.0), 0.05, PRIOR_DAYS).unwrap();
        assert!((none_seen - 0.35 / 97.0).abs() < 1e-12);
        assert_eq!(shrunk_rate(seen(0.0, 0.0), 0.05, PRIOR_DAYS), Some(0.05));
        assert_eq!(shrunk_rate(seen(1.0, 10.0), 0.0, PRIOR_DAYS), None);
        assert_eq!(shrunk_rate(seen(-1.0, 10.0), 0.05, PRIOR_DAYS), None);
        assert_eq!(shrunk_rate(seen(1.0, f64::NAN), 0.05, PRIOR_DAYS), None);
        assert_eq!(shrunk_rate(seen(1.0, 10.0), 0.05, 0.0), None);
        assert_eq!(Exposure::of_interval(Some(0.0), Some(10.0)), None);
        assert_eq!(
            Exposure::of_interval(Some(3.0), Some(10.0)),
            Some(seen(3.0, 30.0))
        );
    }

    #[test]
    fn a_product_line_pools_its_own_results() {
        let at = |line, arrival, condition| Evidence {
            product_line_id: line,
            store_win_share: Some(0.5),
            buyer_arrival: arrival,
            condition_rate: condition,
        };
        let forecasts = forecasts(
            &[
                at(1, Some(seen(1.0, 10.0)), Some(seen(2.0, 40.0))),
                at(1, Some(seen(9.0, 90.0)), Some(seen(6.0, 40.0))),
                at(2, Some(seen(1.0, 50.0)), None),
                at(2, None, Some(seen(1.0, 5.0))),
            ],
            &Pools::new(),
        );
        let thin = forecasts[0].as_ref().unwrap();
        assert_eq!((thin.method, thin.prior_days), (METHOD, PRIOR_DAYS));
        assert_eq!(thin.buyer_arrival.pooled_interval_days, 10.0);
        assert_eq!(thin.buyer_arrival.pool_source, PoolSource::Run);
        // Pooled at the line's own interval, a thin rate stays where it is.
        assert!((thin.buyer_arrival.interval_days - 10.0).abs() < 1e-9);
        assert!(
            (thin.buyer_arrival.median_sell_days - LN_2 * thin.buyer_arrival.interval_days / 0.5)
                .abs()
                < 1e-9
        );
        let condition = thin.condition_rate.as_ref().unwrap();
        assert_eq!(condition.pooled_interval_days, 10.0);
        let expected = 1.0 / ((0.1 * PRIOR_DAYS + 2.0) / (PRIOR_DAYS + 40.0));
        assert!((condition.interval_days - expected).abs() < 1e-9);
        // Another line pools apart, and a result without buyer arrival has no forecast.
        let other = forecasts[2].as_ref().unwrap();
        assert_eq!(other.buyer_arrival.pooled_interval_days, 50.0);
        assert_eq!(other.condition_rate, None);
        assert_eq!(forecasts[3], None);
    }

    #[test]
    fn a_stored_pool_outweighs_the_run_alone() {
        // One SKU in the run, alone in its line: without a stored pool it pools with itself.
        let thin = Evidence {
            product_line_id: 1,
            store_win_share: Some(0.5),
            buyer_arrival: Some(seen(1.0, 30.0)),
            condition_rate: Some(seen(2.0, 120.0)),
        };
        let alone = forecasts(&[thin], &Pools::new())[0].clone().unwrap();
        assert!((alone.buyer_arrival.interval_days - 30.0).abs() < 1e-9);
        // The line's stored results sell every 5 days at the price and every 10 in the condition.
        let stored = Pools::from([(
            1,
            Pool {
                buyer_arrival: seen(200.0, 1000.0),
                condition_rate: seen(100.0, 1000.0),
            },
        )]);
        let pooled = forecasts(&[thin], &stored)[0].clone().unwrap();
        let arrival = &pooled.buyer_arrival;
        assert_eq!(
            (arrival.pool_source, arrival.pooled_interval_days),
            (PoolSource::Stored, 5.0)
        );
        let expected = (PRIOR_DAYS + 30.0) / (0.2 * PRIOR_DAYS + 1.0);
        assert!((arrival.interval_days - expected).abs() < 1e-9);
        let condition = pooled.condition_rate.unwrap();
        assert_eq!(
            (condition.pool_source, condition.pooled_interval_days),
            (PoolSource::Stored, 10.0)
        );
        // A line stored without condition sales falls back to the run for that rate alone.
        let partial = Pools::from([(
            1,
            Pool {
                buyer_arrival: seen(200.0, 1000.0),
                condition_rate: Exposure::default(),
            },
        )]);
        let mixed = forecasts(&[thin], &partial)[0].clone().unwrap();
        assert_eq!(mixed.buyer_arrival.pool_source, PoolSource::Stored);
        assert_eq!(mixed.condition_rate.unwrap().pool_source, PoolSource::Run);
        // Another line's stored pool is not this line's.
        let elsewhere = Pools::from([(2, stored[&1])]);
        let other = forecasts(&[thin], &elsewhere)[0].clone().unwrap();
        assert_eq!(other.buyer_arrival.pool_source, PoolSource::Run);
    }
}
