//! How often buyers pay at least a price, from a product's latest sales: the interval between
//! them over the time the sales could have happened. Ported from `buyerArrivalRate.ts`.
use crate::js_math::JsMath;

const MILLISECONDS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// The shortest exposure a capped history is read over: an hour.
const MINIMUM_CAPPED_EXPOSURE_DAYS: f64 = 1.0 / 24.0;

/// Days of sales the latest-sales API returns, when it does not stop at its limit first.
pub const LATEST_SALES_HISTORY_DAYS: f64 = 90.0;
/// The most sales the latest-sales API returns.
pub const LATEST_SALES_LIMIT: usize = 100;

/// A sale as the estimate reads it: its price and when it happened, in epoch milliseconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Observation {
    pub price: f64,
    pub timestamp: f64,
}

/// Why the exposure starts where it does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExposureStart {
    /// Ninety days back: the API returned fewer sales than its limit.
    HistoryWindow,
    /// The oldest sale returned: the API stopped at its limit.
    SalesCap,
    /// When the product could first be bought.
    Availability,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Estimate {
    pub interval_days: Option<f64>,
    pub qualifying_sales_count: usize,
    pub weighted_sales_count: f64,
    pub observation_days: f64,
    pub effective_exposure_days: f64,
    pub history_capped: bool,
    pub exposure_start: ExposureStart,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Options {
    /// Epoch milliseconds the estimate is for.
    pub as_of: f64,
    /// Days after which a sale counts half; none counts every sale fully.
    pub half_life_days: Option<f64>,
    /// When the product could first be bought, in epoch milliseconds.
    pub available_since: Option<f64>,
}

/// `estimateBuyerArrivalAtPrice`.
pub fn estimate_at_price(sales: &[Observation], target_price: f64, options: Options) -> Estimate {
    let as_of = options.as_of;
    let mut valid: Vec<Observation> = sales
        .iter()
        .copied()
        .filter(|s| s.price > 0.0 && s.timestamp.is_finite() && s.timestamp <= as_of)
        .collect();
    // Newest first; a stable sort keeps equal times in the order given, as Array.sort does.
    valid.sort_by(|l, r| r.timestamp.total_cmp(&l.timestamp));
    valid.truncate(LATEST_SALES_LIMIT);
    let history_capped = valid.len() == LATEST_SALES_LIMIT;
    let oldest_returned = valid.iter().map(|s| s.timestamp).fold(as_of, f64::min);
    let uncapped_start = as_of - LATEST_SALES_HISTORY_DAYS * MILLISECONDS_PER_DAY;
    let observed_start = if history_capped {
        oldest_returned
    } else {
        uncapped_start
    };
    let provided = options.available_since.filter(|t| t.is_finite());
    let available_since = provided.map(|provided| match valid.last() {
        None => as_of.min(provided),
        Some(oldest) => provided.min(oldest.timestamp),
    });
    let exposure_start = observed_start.max(available_since.unwrap_or(f64::NEG_INFINITY));
    let start = match available_since {
        Some(available) if available > observed_start => ExposureStart::Availability,
        _ if history_capped => ExposureStart::SalesCap,
        _ => ExposureStart::HistoryWindow,
    };
    let observation_days =
        MINIMUM_CAPPED_EXPOSURE_DAYS.max((as_of - exposure_start) / MILLISECONDS_PER_DAY);
    let decay_rate = match options.half_life_days {
        Some(h) if h.is_finite() && h > 0.0 => std::f64::consts::LN_2 / h,
        _ => 0.0,
    };
    let effective_exposure_days = if decay_rate > 0.0 {
        (1.0 - (-decay_rate * observation_days).js_exp()) / decay_rate
    } else {
        observation_days
    };
    let qualifying: Vec<&Observation> = valid
        .iter()
        .filter(|s| s.timestamp >= exposure_start && s.price >= target_price)
        .collect();
    let weighted_sales_count = qualifying.iter().fold(0.0, |total, sale| {
        let age_days = (as_of - sale.timestamp) / MILLISECONDS_PER_DAY;
        total
            + if decay_rate > 0.0 {
                (-decay_rate * age_days).js_exp()
            } else {
                1.0
            }
    });
    Estimate {
        interval_days: (weighted_sales_count > 0.0)
            .then(|| effective_exposure_days / weighted_sales_count),
        qualifying_sales_count: qualifying.len(),
        weighted_sales_count,
        observation_days,
        effective_exposure_days,
        history_capped,
        exposure_start: start,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: f64 = MILLISECONDS_PER_DAY;
    const AS_OF: f64 = 1_788_134_400_000.0; // 2026-08-31T00:00:00Z

    fn sale(price: f64, age_days: f64) -> Observation {
        Observation {
            price,
            timestamp: AS_OF - age_days * DAY,
        }
    }

    fn options(available_since: Option<f64>, half_life_days: Option<f64>) -> Options {
        Options {
            as_of: AS_OF,
            half_life_days,
            available_since,
        }
    }

    #[test]
    fn a_sparse_history_is_read_over_ninety_days() {
        let sparse = estimate_at_price(
            &[sale(10.0, 1.0), sale(10.0, 2.0)],
            10.0,
            options(None, None),
        );
        assert_eq!(sparse.interval_days, Some(45.0));
        assert_eq!(sparse.observation_days, 90.0);
        assert!(!sparse.history_capped);
        assert_eq!(sparse.exposure_start, ExposureStart::HistoryWindow);
    }

    #[test]
    fn a_recent_release_is_read_from_its_availability() {
        let recent = estimate_at_price(
            &[sale(10.0, 1.0), sale(10.0, 2.0)],
            10.0,
            options(Some(AS_OF - 10.0 * DAY), None),
        );
        assert_eq!(recent.interval_days, Some(5.0));
        assert_eq!(recent.observation_days, 10.0);
        assert_eq!(recent.exposure_start, ExposureStart::Availability);
        // An observed presale proves the market was open before release.
        let presale = estimate_at_price(
            &[sale(10.0, 1.0), sale(10.0, 2.0)],
            10.0,
            options(Some(AS_OF + 10.0 * DAY), None),
        );
        assert_eq!(presale.qualifying_sales_count, 2);
        assert_eq!(presale.observation_days, 2.0);
        assert_eq!(presale.interval_days, Some(1.0));
        assert_eq!(presale.exposure_start, ExposureStart::Availability);
    }

    #[test]
    fn a_capped_history_is_read_from_its_oldest_sale() {
        let sales: Vec<_> = (0..LATEST_SALES_LIMIT)
            .map(|i| sale(10.0, (2 * i) as f64 / (LATEST_SALES_LIMIT - 1) as f64))
            .collect();
        let capped = estimate_at_price(&sales, 10.0, options(None, None));
        assert!((capped.interval_days.unwrap() - 0.02).abs() < 1e-10);
        assert_eq!(capped.observation_days, 2.0);
        assert!(capped.history_capped);
        assert_eq!(capped.exposure_start, ExposureStart::SalesCap);
    }

    #[test]
    fn sales_below_the_price_and_old_sales_count_less() {
        let none = estimate_at_price(
            &[sale(5.0, 1.0), sale(5.0, 2.0)],
            10.0,
            options(None, Some(7.0)),
        );
        assert_eq!(none.interval_days, None);
        assert_eq!(none.qualifying_sales_count, 0);
        let decayed = estimate_at_price(
            &[sale(10.0, 0.0), sale(10.0, 14.0)],
            10.0,
            options(None, Some(7.0)),
        );
        assert!(decayed.weighted_sales_count > 1.0 && decayed.weighted_sales_count < 2.0);
        assert!(decayed.effective_exposure_days < decayed.observation_days);
    }
}
