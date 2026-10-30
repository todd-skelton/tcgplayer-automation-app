//! A SKU's price curve from its product's latest sales: each percentile of the time-decayed sale
//! prices, how often buyers pay that much, and how long a listing there waits once competing
//! asks share the buyers. Ported from `getSuggestedPriceFromLatestSales.ts` with its tests.

use super::buyer_arrival_rate::{self, Observation as ArrivalSale};
use super::condition_normalization::Normalized;
use super::policy::SupplyStatus;
use super::supply_analysis::{self, Observation as Supply};

const MILLISECONDS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// Sale intervals per half-life when no half-life is set.
const INTERVALS_PER_HALF_LIFE: f64 = 24.0;
pub const DEFAULT_HALF_LIFE_DAYS: f64 = 7.0;
pub const DEFAULT_PERCENTILE: f64 = 80.0;

/// The standard curve: the 5th through 95th percentile in five-point steps.
pub const PERCENTILES: [f64; 19] = [
    5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0,
    85.0, 90.0, 95.0,
];

/// `Math.round`: halves round toward positive infinity.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// One point of the curve.
#[derive(Clone, Debug, PartialEq)]
pub struct Point {
    pub percentile: f64,
    pub price: f64,
    /// Milliseconds between buyers paying at least the price.
    pub historical_sales_velocity_ms: Option<f64>,
    /// Median milliseconds to sell once competing asks share the buyers.
    pub estimated_time_to_sell_ms: Option<f64>,
    pub sales_count: usize,
    pub history_capped: bool,
    pub listings_count: Option<usize>,
    pub store_win_share: Option<f64>,
    pub supply_status: SupplyStatus,
}

pub struct CurveOptions<'a> {
    pub half_life_days: f64,
    pub percentiles: &'a [f64],
    /// Epoch milliseconds the curve is for.
    pub as_of: f64,
    pub available_since: Option<f64>,
    pub supply: &'a Supply,
}

/// `getTimeDecayedPercentileWeightedSuggestedPrice`: each percentile of the sale prices, a sale
/// counting half once it is a half-life old, interpolated between the sales either side.
pub fn curve(sales: &[Normalized], options: &CurveOptions) -> Vec<Point> {
    if sales.is_empty() {
        return Vec::new();
    }
    let now = options.as_of;
    let mut weighted: Vec<(f64, f64)> = sales
        .iter()
        .map(|sale| {
            let age_days = (now - sale.timestamp) / MILLISECONDS_PER_DAY;
            (sale.price, 0.5f64.powf(age_days / options.half_life_days))
        })
        .collect();
    weighted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total_weight: f64 = weighted.iter().map(|(_, weight)| weight).sum();
    if total_weight == 0.0 {
        return Vec::new();
    }
    let mut cumulative = 0.0;
    let cumulative: Vec<(f64, f64)> = weighted
        .iter()
        .map(|(price, weight)| {
            cumulative += weight;
            (*price, cumulative)
        })
        .collect();
    let arrivals: Vec<ArrivalSale> = sales
        .iter()
        .map(|sale| ArrivalSale {
            price: sale.price,
            timestamp: sale.timestamp,
        })
        .collect();

    options
        .percentiles
        .iter()
        .map(|&p| {
            let price = percentile_price(&cumulative, p, total_weight);
            let arrival = buyer_arrival_rate::estimate_at_price(
                &arrivals,
                price,
                buyer_arrival_rate::Options {
                    as_of: now,
                    half_life_days: Some(options.half_life_days),
                    available_since: options.available_since,
                },
            );
            let historical_sales_velocity_ms = arrival
                .interval_days
                .filter(|days| *days != 0.0 && !days.is_nan())
                .map(|days| js_round(days * MILLISECONDS_PER_DAY));
            let observed = options.supply.status == SupplyStatus::Observed;
            let adjusted = observed.then(|| {
                supply_analysis::supply_adjusted_time_to_sell(
                    &options.supply.listings,
                    price,
                    historical_sales_velocity_ms,
                )
            });
            Point {
                percentile: p,
                price,
                historical_sales_velocity_ms,
                estimated_time_to_sell_ms: adjusted
                    .and_then(|a| a.time_ms)
                    .filter(|ms| *ms != 0.0 && !ms.is_nan())
                    .map(js_round),
                sales_count: arrival.qualifying_sales_count,
                history_capped: arrival.history_capped,
                listings_count: adjusted.map(|a| a.listings_count),
                store_win_share: adjusted.map(|a| a.store_win_share),
                supply_status: options.supply.status,
            }
        })
        .collect()
}

fn percentile_price(cumulative: &[(f64, f64)], p: f64, total_weight: f64) -> f64 {
    let last = cumulative[cumulative.len() - 1].0;
    if p == 0.0 {
        return cumulative[0].0;
    }
    if p == 100.0 {
        return last;
    }
    let target = p / 100.0 * total_weight;
    let Some(upper) = cumulative.iter().position(|(_, weight)| *weight >= target) else {
        return last;
    };
    let lower = upper.saturating_sub(1);
    if lower == upper {
        return cumulative[upper].0;
    }
    let (lower_price, lower_weight) = cumulative[lower];
    let (upper_price, upper_weight) = cumulative[upper];
    let weight_diff = upper_weight - lower_weight;
    let ratio = if weight_diff == 0.0 {
        0.0
    } else {
        (target - lower_weight) / weight_diff
    };
    lower_price + (upper_price - lower_price) * ratio
}

/// A half-life of 24 average sale intervals, at least a day; unbounded with one sale or none.
pub fn dynamic_half_life(sales: &[Normalized]) -> f64 {
    if sales.len() <= 1 {
        return f64::INFINITY;
    }
    let mut timestamps: Vec<f64> = sales.iter().map(|s| s.timestamp).collect();
    timestamps.sort_by(f64::total_cmp);
    let span = timestamps[timestamps.len() - 1] - timestamps[0];
    let average_interval = span / (sales.len() - 1) as f64;
    let half_life_ms = average_interval * INTERVALS_PER_HALF_LIFE;
    MILLISECONDS_PER_DAY.max(js_round(half_life_ms)) / MILLISECONDS_PER_DAY
}

pub struct SuggestOptions<'a> {
    pub percentile: f64,
    pub additional_percentiles: &'a [f64],
    /// Zero or none uses [`dynamic_half_life`].
    pub half_life_days: Option<f64>,
    pub as_of: f64,
    pub available_since: Option<f64>,
    pub supply: &'a Supply,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
    pub suggested_price: Option<f64>,
    pub total_quantity: f64,
    pub sale_count: usize,
    pub historical_sales_velocity_ms: Option<f64>,
    pub estimated_time_to_sell_ms: Option<f64>,
    pub sales_count: Option<usize>,
    pub listings_count: Option<usize>,
    pub percentiles: Vec<Point>,
}

/// `getSuggestedPriceFromSales`: the standard curve plus the target percentile and any others,
/// and the target's point as the suggestion.
pub fn suggest(sales: &[Normalized], options: &SuggestOptions) -> Suggestion {
    let half_life_days = options
        .half_life_days
        .filter(|days| *days != 0.0 && !days.is_nan())
        .unwrap_or_else(|| dynamic_half_life(sales));
    let mut percentiles: Vec<f64> = Vec::new();
    for p in PERCENTILES
        .iter()
        .chain([options.percentile].iter())
        .chain(options.additional_percentiles)
    {
        if !percentiles.contains(p) {
            percentiles.push(*p);
        }
    }
    percentiles.sort_by(f64::total_cmp);
    let points = curve(
        sales,
        &CurveOptions {
            half_life_days,
            percentiles: &percentiles,
            as_of: options.as_of,
            available_since: options.available_since,
            supply: options.supply,
        },
    );
    let total_quantity = sales
        .iter()
        .map(|s| if s.quantity.is_nan() { 0.0 } else { s.quantity })
        .sum();
    let target = points.iter().find(|p| p.percentile == options.percentile);
    Suggestion {
        suggested_price: target.map(|t| t.price),
        total_quantity,
        sale_count: sales.len(),
        historical_sales_velocity_ms: target.and_then(|t| t.historical_sales_velocity_ms),
        estimated_time_to_sell_ms: target.and_then(|t| t.estimated_time_to_sell_ms),
        sales_count: target.map(|t| t.sales_count),
        listings_count: target.and_then(|t| t.listings_count),
        percentiles: points,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_788_220_800_000.0; // 2026-09-01T00:00:00Z

    fn two_sales() -> [Normalized; 2] {
        [
            Normalized {
                price: 1.0,
                quantity: 1.0,
                timestamp: NOW - 86_400_000.0,
            },
            Normalized {
                price: 2.0,
                quantity: 1.0,
                timestamp: NOW,
            },
        ]
    }

    fn suggest_at_73(supply: &Supply) -> Suggestion {
        suggest(
            &two_sales(),
            &SuggestOptions {
                percentile: 73.0,
                additional_percentiles: &[],
                half_life_days: Some(7.0),
                as_of: NOW,
                available_since: None,
                supply,
            },
        )
    }

    #[test]
    fn standard_curves_cover_the_5th_through_95th_in_five_point_steps() {
        let expected: Vec<f64> = (0..19).map(|i| 5.0 + i as f64 * 5.0).collect();
        assert_eq!(PERCENTILES.to_vec(), expected);
    }

    #[test]
    fn the_no_competition_forecast_is_the_median_buyer_arrival() {
        let observed = Supply {
            status: SupplyStatus::Observed,
            listings: Vec::new(),
        };
        let curve = suggest_at_73(&observed);
        let velocity = curve.historical_sales_velocity_ms.unwrap();
        assert!(
            (curve.estimated_time_to_sell_ms.unwrap() - velocity * std::f64::consts::LN_2).abs()
                < 2.0
        );
        let mut expected = PERCENTILES.to_vec();
        expected.push(73.0);
        expected.sort_by(f64::total_cmp);
        let percentiles: Vec<f64> = curve.percentiles.iter().map(|p| p.percentile).collect();
        assert_eq!(
            percentiles, expected,
            "a custom target joins the standard curve"
        );
    }

    #[test]
    fn missing_listing_evidence_is_not_zero_competition() {
        let curve = suggest_at_73(&Supply::unavailable());
        assert_eq!(curve.estimated_time_to_sell_ms, None);
        assert_eq!(
            curve.percentiles[0].supply_status,
            SupplyStatus::Unavailable
        );
    }

    #[test]
    fn percentiles_interpolate_between_the_weighted_sales_either_side() {
        // Equal weights 1 and 1: the 50th sits on the first sale, the 75th halfway up.
        let sales = [
            Normalized {
                price: 10.0,
                quantity: 1.0,
                timestamp: NOW,
            },
            Normalized {
                price: 20.0,
                quantity: 2.0,
                timestamp: NOW,
            },
        ];
        let points = curve(
            &sales,
            &CurveOptions {
                half_life_days: 7.0,
                percentiles: &[0.0, 25.0, 50.0, 75.0, 100.0],
                as_of: NOW,
                available_since: None,
                supply: &Supply::disabled(),
            },
        );
        let prices: Vec<f64> = points.iter().map(|p| p.price).collect();
        assert_eq!(prices, [10.0, 10.0, 10.0, 15.0, 20.0]);
    }

    #[test]
    fn the_dynamic_half_life_is_24_sale_intervals_and_at_least_a_day() {
        let sale = |days: f64| Normalized {
            price: 1.0,
            quantity: 1.0,
            timestamp: NOW - days * MILLISECONDS_PER_DAY,
        };
        assert_eq!(dynamic_half_life(&[sale(0.0)]), f64::INFINITY);
        assert_eq!(dynamic_half_life(&[sale(0.0), sale(2.0), sale(4.0)]), 48.0);
        assert_eq!(dynamic_half_life(&[sale(0.0), sale(0.01)]), 1.0);
    }
}
