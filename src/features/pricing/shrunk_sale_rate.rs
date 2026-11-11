//! A sale rate shrunk toward its product line's: the Gamma-Poisson posterior mean
//! `(alpha + sales) / (beta + exposure days)`, its Gamma prior a week of the line's pooled rate,
//! so a thin history leans on the line and a long one speaks for itself. Recorded beside the other
//! sell-time forecasts to be graded (`features::forecast_calibration`); pricing does not read it.
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

    fn plus(self, other: Exposure) -> Exposure {
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

/// One rate, shrunk, and the median wait it forecasts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShrunkRate {
    pub sales: f64,
    pub exposure_days: f64,
    /// Days between sales across the product line's SKUs priced in the same run: the prior's mean.
    pub pooled_interval_days: f64,
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

fn shrink(
    evidence: Exposure,
    pooled: Exposure,
    store_win_share: Option<f64>,
) -> Option<ShrunkRate> {
    let pooled_rate = pooled.rate()?;
    let interval_days = 1.0 / shrunk_rate(evidence, pooled_rate, PRIOR_DAYS)?;
    Some(ShrunkRate {
        sales: evidence.sales,
        exposure_days: evidence.days,
        pooled_interval_days: 1.0 / pooled_rate,
        interval_days,
        median_sell_days: median_sell_days(Some(interval_days), store_win_share, None)?,
    })
}

/// Each result's forecast, its prior pooled over the results of the same product line: their
/// sales over their days, so each SKU weighs as its evidence does.
pub fn forecasts(evidence: &[Evidence]) -> Vec<Option<Forecast>> {
    let mut pooled: HashMap<i64, (Exposure, Exposure)> = HashMap::new();
    for e in evidence {
        let (arrival, condition) = pooled.entry(e.product_line_id).or_default();
        if let Some(seen) = e.buyer_arrival {
            *arrival = arrival.plus(seen);
        }
        if let Some(seen) = e.condition_rate {
            *condition = condition.plus(seen);
        }
    }
    evidence
        .iter()
        .map(|e| {
            let (arrival, condition) = pooled[&e.product_line_id];
            Some(Forecast {
                method: METHOD,
                prior_days: PRIOR_DAYS,
                buyer_arrival: shrink(e.buyer_arrival?, arrival, e.store_win_share)?,
                condition_rate: e
                    .condition_rate
                    .and_then(|seen| shrink(seen, condition, e.store_win_share)),
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
        let forecasts = forecasts(&[
            at(1, Some(seen(1.0, 10.0)), Some(seen(2.0, 40.0))),
            at(1, Some(seen(9.0, 90.0)), Some(seen(6.0, 40.0))),
            at(2, Some(seen(1.0, 50.0)), None),
            at(2, None, Some(seen(1.0, 5.0))),
        ]);
        let thin = forecasts[0].as_ref().unwrap();
        assert_eq!((thin.method, thin.prior_days), (METHOD, PRIOR_DAYS));
        assert_eq!(thin.buyer_arrival.pooled_interval_days, 10.0);
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
}
