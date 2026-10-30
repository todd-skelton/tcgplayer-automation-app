//! How often the listed condition alone sells, from a year of the SKU's own weekly sales counts.
//! Ported from `conditionSaleRate.ts`.
use chrono::NaiveDate;
use serde::Serialize;

use super::policy::median_sell_days;

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const YEAR_DAYS: f64 = 364.0;
const QUARTER_DAYS: f64 = 91.0;
/// A window shorter than a week says nothing about a rate.
const MINIMUM_WINDOW_DAYS: f64 = 7.0;
const BUCKET_DAYS: f64 = 7.0;
pub const METHOD: &str = "annual-buckets-v1";

/// One bucket of the SKU's sales history, as the price history API reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct SalesBucket {
    /// `YYYY-MM-DD`, read as UTC midnight.
    pub bucket_start_date: String,
    pub transaction_count: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleRate {
    /// Mean days between sales of this SKU, weighted toward the last quarter.
    pub interval_days: f64,
    /// Sales of the SKU in the year.
    pub transactions: f64,
    pub method: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateForecast {
    pub interval_days: f64,
    pub transactions: f64,
    pub method: &'static str,
    pub median_sell_days: f64,
}

/// `new Date("YYYY-MM-DD").getTime()`: UTC midnight, or NaN for text that is not a date.
fn start_ms(date: &str) -> f64 {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map_or(f64::NAN, |t| t.and_utc().timestamp_millis() as f64)
}

/// The mean of the yearly and quarterly rates, so the latest quarter counts twice. Held out
/// against the following month, that blend ranked slow SKUs best.
pub fn estimate(
    buckets: &[SalesBucket],
    as_of: f64,
    available_since: Option<f64>,
) -> Option<SaleRate> {
    let available_since = available_since.unwrap_or(f64::NEG_INFINITY);
    let starts: Vec<f64> = buckets
        .iter()
        .map(|b| start_ms(&b.bucket_start_date))
        .collect();
    let bucket_ms = if starts.len() > 1 {
        (starts[0] - starts[1]).abs()
    } else {
        BUCKET_DAYS * DAY_MS
    };
    // A window counts every bucket overlapping it, so a bucket straddling its start keeps its
    // sales; the days are the window's own.
    let window = |days: f64| {
        let start = (as_of - days * DAY_MS).max(available_since);
        let transactions = buckets
            .iter()
            .zip(&starts)
            .fold(0.0, |total, (bucket, &started)| {
                if started + bucket_ms > start && started <= as_of {
                    let count = bucket.transaction_count;
                    total + if count.is_nan() { 0.0 } else { count }
                } else {
                    total
                }
            });
        (transactions, (as_of - start) / DAY_MS)
    };
    let (year_transactions, year_days) = window(YEAR_DAYS);
    let (quarter_transactions, quarter_days) = window(QUARTER_DAYS);
    if year_transactions == 0.0 || quarter_days < MINIMUM_WINDOW_DAYS {
        return None;
    }
    let rate = (year_transactions / year_days + quarter_transactions / quarter_days) / 2.0;
    Some(SaleRate {
        interval_days: 1.0 / rate,
        transactions: year_transactions,
        method: METHOD,
    })
}

/// Median wait at a price where the store wins the given share of buyers.
pub fn forecast(rate: Option<&SaleRate>, store_win_share: Option<f64>) -> Option<RateForecast> {
    let rate = rate?;
    let days = median_sell_days(Some(rate.interval_days), store_win_share, None)?;
    Some(RateForecast {
        interval_days: rate.interval_days,
        transactions: rate.transactions,
        method: rate.method,
        median_sell_days: days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AS_OF: f64 = 1_788_523_200_000.0; // 2026-09-04T12:00:00Z

    fn date(ms: f64) -> String {
        chrono::DateTime::from_timestamp_millis(ms as i64)
            .unwrap()
            .format("%Y-%m-%d")
            .to_string()
    }

    fn weeks(counts: &[(usize, f64)]) -> Vec<SalesBucket> {
        (0..52)
            .map(|ago| SalesBucket {
                bucket_start_date: date(AS_OF - ago as f64 * 7.0 * DAY_MS),
                transaction_count: counts
                    .iter()
                    .find(|(w, _)| *w == ago)
                    .map_or(0.0, |(_, c)| *c),
            })
            .collect()
    }

    fn close(actual: Option<f64>, expected: f64) {
        assert!(
            (actual.unwrap() - expected).abs() < 1e-9,
            "{actual:?} vs {expected}"
        );
    }

    #[test]
    fn blends_a_year_and_a_quarter() {
        let steady = estimate(
            &weeks(&[
                (1, 2.0),
                (5, 1.0),
                (9, 3.0),
                (20, 2.0),
                (30, 2.0),
                (45, 2.0),
            ]),
            AS_OF,
            None,
        )
        .unwrap();
        assert_eq!(steady.transactions, 12.0);
        assert_eq!(steady.method, METHOD);
        close(
            Some(steady.interval_days),
            1.0 / ((12.0 / 364.0 + 6.0 / 91.0) / 2.0),
        );
        let f = forecast(Some(&steady), Some(0.5)).unwrap();
        close(
            Some(f.median_sell_days),
            std::f64::consts::LN_2 * steady.interval_days / 0.5,
        );
        assert_eq!(forecast(Some(&steady), Some(0.0)), None);
        assert_eq!(forecast(Some(&steady), None), None);
        assert_eq!(forecast(None, Some(0.5)), None);
    }

    #[test]
    fn a_release_date_starts_both_windows() {
        let fresh = estimate(
            &weeks(&[(1, 2.0), (3, 1.0), (40, 5.0)]),
            AS_OF,
            Some(AS_OF - 30.0 * DAY_MS),
        )
        .unwrap();
        assert_eq!(fresh.transactions, 3.0);
        close(Some(fresh.interval_days), 10.0);
        let straddling = estimate(
            &[SalesBucket {
                bucket_start_date: "2026-08-23".into(),
                transaction_count: 3.0,
            }],
            AS_OF,
            Some(AS_OF - 10.0 * DAY_MS),
        );
        close(straddling.map(|r| r.interval_days), 10.0 / 3.0);
    }

    #[test]
    fn no_rate_without_sales_a_week_or_past_buckets() {
        assert_eq!(estimate(&weeks(&[]), AS_OF, None), None);
        assert_eq!(
            estimate(&weeks(&[(0, 4.0)]), AS_OF, Some(AS_OF - 3.0 * DAY_MS)),
            None
        );
        let future = [SalesBucket {
            bucket_start_date: "2027-01-01".into(),
            transaction_count: 9.0,
        }];
        assert_eq!(estimate(&future, AS_OF, None), None);
    }
}
