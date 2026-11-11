//! Sell-time forecast calibration (`features/forecast-calibration`): how the continuous pricing
//! seller's listings sold against the sell-time forecasts they were published with, over a
//! trailing window that ends where the latest complete order history sync ends. The latest
//! quarter of the window is held out to check the rate measured before it. Every forecast a price
//! was published with is graded side by side, by its actual days per forecast day and by its
//! Brier score on whether the listing sold within each of [`HORIZON_DAYS`].
//!
//! Times are whole milliseconds, as the Node app's dates hold them, so the report reads to the
//! same figures.
mod evidence;
pub mod json_route;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use evidence::load;

use crate::{
    features::inventory_economics::ledger::{assumptions::js_round, proceeds::iso},
    js_math::JsMath,
};

const DAY_MS: i64 = 86_400_000;

/// Trailing days of listings and orders a calibration can be learned from.
pub const WINDOW_DAYS: [u32; 3] = [28, 56, 84];
pub const DEFAULT_WINDOW_DAYS: u32 = 56;

/// The latest share of the window, held out to check the rate measured before it.
const HELD_OUT_SHARE: f64 = 0.25;
/// Pseudo-sales exactly as forecast that steady a thin sample.
const PRIOR_SALES: f64 = 20.0;
/// Sales seen or forecast, whichever is larger, each part of the window needs.
const MINIMUM_EARLIER_SALES: f64 = 40.0;
const MINIMUM_HELD_OUT_SALES: f64 = 15.0;

/// Days after listing a forecast's chance of a sale is scored at.
pub const HORIZON_DAYS: [u32; 3] = [14, 21, 28];

/// A price published with a modeled sell-time forecast.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct ListedPrice {
    pub sku: i32,
    pub listed_at: DateTime<Utc>,
    /// When the SKU's next price was published; none while this one is still listed.
    pub replaced_at: Option<DateTime<Utc>>,
    /// Copies in stock when inventory was counted for the pricing run.
    pub quantity: i32,
    /// When that count was taken; copies sold after it but before listing were already gone.
    pub counted_at: DateTime<Utc>,
    /// The curve's median days to sell at this price.
    pub forecast_median_sell_days: f64,
    /// The other forecasts' median days to sell, each by its current method; none where the price
    /// was published without one.
    pub buyer_choice_median_sell_days: Option<f64>,
    pub condition_rate_median_sell_days: Option<f64>,
    pub shrunk_rate_median_sell_days: Option<f64>,
    pub shrunk_condition_rate_median_sell_days: Option<f64>,
    pub quality_share_median_sell_days: Option<f64>,
}

/// A sell-time forecast a price can be published with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Forecast {
    /// The pricing curve's, the one pricing selects prices by.
    Curve,
    BuyerChoice,
    ConditionRate,
    /// The curve's buyer arrival shrunk toward its product line's pooled rate.
    ShrunkRate,
    ShrunkConditionRate,
    /// The store's share of buyers once every competing ask is weighed by price, copies and seller
    /// quality.
    QualityShare,
}

impl Forecast {
    pub const ALL: [Forecast; 6] = [
        Forecast::Curve,
        Forecast::BuyerChoice,
        Forecast::ConditionRate,
        Forecast::ShrunkRate,
        Forecast::ShrunkConditionRate,
        Forecast::QualityShare,
    ];

    /// Its median days to sell at the price, when it was published with one.
    fn median_sell_days(self, price: &ListedPrice) -> Option<f64> {
        match self {
            Forecast::Curve => Some(price.forecast_median_sell_days),
            Forecast::BuyerChoice => price.buyer_choice_median_sell_days,
            Forecast::ConditionRate => price.condition_rate_median_sell_days,
            Forecast::ShrunkRate => price.shrunk_rate_median_sell_days,
            Forecast::ShrunkConditionRate => price.shrunk_condition_rate_median_sell_days,
            Forecast::QualityShare => price.quality_share_median_sell_days,
        }
        .filter(|days| days.is_finite() && *days > 0.0)
    }
}

/// Copies of one SKU sold in one order.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct SkuSale {
    pub sku: i32,
    pub sold_at: DateTime<Utc>,
    pub quantity: i32,
}

/// Time listings spent in stock, the sales seen, and the sales the forecasts expected over it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeInStock {
    pub listings: f64,
    pub in_stock_days: f64,
    pub sales: f64,
    pub forecast_sales: f64,
}

impl TimeInStock {
    /// Days to sell per forecast day that best explain the sales seen, steadied by pseudo-sales
    /// exactly as forecast.
    pub fn actual_days_per_forecast_day(&self) -> f64 {
        (self.forecast_sales + PRIOR_SALES) / (self.sales + PRIOR_SALES)
    }

    pub fn plus(&self, other: &TimeInStock) -> TimeInStock {
        TimeInStock {
            listings: self.listings + other.listings,
            in_stock_days: self.in_stock_days + other.in_stock_days,
            sales: self.sales + other.sales,
            forecast_sales: self.forecast_sales + other.forecast_sales,
        }
    }

    /// How likely the sales seen are if listings take `days_per_forecast_day`, up to a constant;
    /// higher fits better.
    fn likelihood(&self, days_per_forecast_day: f64) -> f64 {
        -self.sales * days_per_forecast_day.js_ln() - self.forecast_sales / days_per_forecast_day
    }

    /// Sales seen or forecast, whichever is larger: either is enough to show a forecast is off.
    fn evidence(&self) -> f64 {
        self.sales.max(self.forecast_sales)
    }
}

/// How a forecast's chances of a sale within a horizon held up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HorizonScore {
    pub horizon_days: u32,
    /// Prices followed for the whole horizon, or until they sold.
    pub listings: f64,
    /// The share of them that sold within it.
    pub sold_share: Option<f64>,
    /// The mean chance the forecast gave them of selling within it.
    pub forecast_sold_share: Option<f64>,
    /// The mean squared difference between that chance and whether they sold: lower is better.
    pub brier_score: Option<f64>,
    /// The pricing curve's Brier score on the same prices, so forecasts compare on even terms.
    pub curve_brier_score: Option<f64>,
}

/// Sums a [`HorizonScore`] is read from.
#[derive(Clone, Copy, Default)]
struct HorizonTally {
    listings: f64,
    sold: f64,
    forecast_sold: f64,
    squared_error: f64,
    curve_squared_error: f64,
}

impl HorizonTally {
    fn add(&mut self, chance: f64, curve_chance: f64, sold: bool) {
        let outcome = if sold { 1.0 } else { 0.0 };
        self.listings += 1.0;
        self.sold += outcome;
        self.forecast_sold += chance;
        self.squared_error += (chance - outcome).powi(2);
        self.curve_squared_error += (curve_chance - outcome).powi(2);
    }

    fn score(&self, horizon_days: u32) -> HorizonScore {
        let mean = |sum: f64| (self.listings > 0.0).then(|| sum / self.listings);
        HorizonScore {
            horizon_days,
            listings: self.listings,
            sold_share: mean(self.sold),
            forecast_sold_share: mean(self.forecast_sold),
            brier_score: mean(self.squared_error),
            curve_brier_score: mean(self.curve_squared_error),
        }
    }
}

/// The chance of at least one sale within `horizon_days` when half of listings sell within
/// `median_sell_days`.
fn chance_sold_within(horizon_days: u32, median_sell_days: f64) -> f64 {
    1.0 - (-std::f64::consts::LN_2 * f64::from(horizon_days) / median_sell_days).exp()
}

/// How one forecast did over the whole window, on the prices published with it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastGrade {
    pub forecast: Forecast,
    pub time_in_stock: TimeInStock,
    pub actual_days_per_forecast_day: f64,
    /// One per [`HORIZON_DAYS`].
    pub horizons: Vec<HorizonScore>,
}

/// Whether the rate measured before the held-out part forecast the held-out sales better than
/// the forecasts as they are.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeldOutCheck {
    Confirmed,
    NotConfirmed,
    TooFewSales,
}

/// How the store's listings sold against their sell-time forecasts over a window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub seller_key: String,
    pub learned_at: String,
    pub evidence_window_days: u32,
    pub from: String,
    pub held_out_from: String,
    pub through: String,
    pub earlier: TimeInStock,
    pub held_out: TimeInStock,
    /// Measured over the earlier part only, and checked against the held-out part.
    pub earlier_actual_days_per_forecast_day: f64,
    pub held_out_check: HeldOutCheck,
    /// Days listings took to sell per forecast day over the whole window: above 1 they sold
    /// slower than forecast.
    pub actual_days_per_forecast_day: f64,
    /// Each forecast, the curve's first, graded over the whole window.
    #[serde(default)]
    pub grades: Vec<ForecastGrade>,
}

fn ms(at: DateTime<Utc>) -> i64 {
    at.timestamp_millis()
}

fn iso_ms(at: i64) -> String {
    DateTime::from_timestamp_millis(at).map_or_else(String::new, iso)
}

fn round_ratio(value: f64) -> f64 {
    js_round(value * 1000.0) as f64 / 1000.0
}

/// Copies of the price's SKU left when it was listed: those counted, less any sold since.
fn in_stock_at_listing(price: &ListedPrice, sales: &[SkuSale]) -> i64 {
    let (counted_at, listed_at) = (ms(price.counted_at), ms(price.listed_at));
    let sold_before_listing: i64 = sales
        .iter()
        .filter(|s| ms(s.sold_at) >= counted_at && ms(s.sold_at) < listed_at)
        .map(|s| i64::from(s.quantity))
        .sum();
    i64::from(price.quantity) - sold_before_listing
}

/// The sales a forecast expects over days in stock: ln 2 / median of them per day.
fn forecast_sales(in_stock_days: f64, median_sell_days: f64) -> f64 {
    (in_stock_days * std::f64::consts::LN_2) / median_sell_days
}

/// `measureListedPrice`: one price's time in stock, from listing until it was replaced, sold
/// out or the evidence ends, given the SKU's sales in time order. Each order is one buyer
/// arriving, whatever it bought, and the forecast expects ln 2 / median of them per day.
pub fn measure(price: &ListedPrice, sales: &[SkuSale], through: i64) -> TimeInStock {
    let start = ms(price.listed_at) as f64;
    let replaced = price.replaced_at.map_or(f64::INFINITY, |at| ms(at) as f64);
    let end = start.max(replaced.min(through as f64));
    let mut in_stock = in_stock_at_listing(price, sales);
    let mut in_stock_until = if in_stock > 0 { end } else { start };
    let mut sold = 0.0;
    for sale in sales {
        let sold_at = ms(sale.sold_at) as f64;
        if in_stock <= 0 || sold_at >= end {
            break;
        }
        if sold_at < start {
            continue;
        }
        sold += 1.0;
        in_stock -= i64::from(sale.quantity);
        if in_stock <= 0 {
            in_stock_until = sold_at;
        }
    }
    let in_stock_days = (in_stock_until - start) / DAY_MS as f64;
    TimeInStock {
        listings: 1.0,
        in_stock_days,
        sales: sold,
        forecast_sales: forecast_sales(in_stock_days, price.forecast_median_sell_days),
    }
}

/// Whether the price's SKU sold within `horizon_days` of listing; none when the evidence ends
/// first or nothing was left to sell. A later price does not end the horizon: the question is
/// what followed the forecasts published with this one.
fn sold_within(
    price: &ListedPrice,
    sales: &[SkuSale],
    horizon_days: u32,
    through: i64,
) -> Option<bool> {
    let start = ms(price.listed_at);
    let end = start + i64::from(horizon_days) * DAY_MS;
    if end > through || in_stock_at_listing(price, sales) <= 0 {
        return None;
    }
    Some(sales.iter().any(|s| (start..end).contains(&ms(s.sold_at))))
}

/// What a calibration is learned from.
pub struct Evidence<'a> {
    pub seller_key: &'a str,
    pub prices: &'a [ListedPrice],
    pub sales: &'a [SkuSale],
    pub from: i64,
    pub through: i64,
    pub learned_at: i64,
    pub evidence_window_days: u32,
}

/// `learnForecastCalibration`: how much longer or shorter the listings took to sell than the
/// curve forecast; the rate measured before the held-out part is confirmed only when it
/// forecasts the held-out sales better than the forecasts as they are.
pub fn learn(evidence: &Evidence) -> Calibration {
    let span = (evidence.through - evidence.from) as f64;
    let held_out_from = (evidence.through as f64 - span * HELD_OUT_SHARE).trunc() as i64;
    let mut by_sku: std::collections::HashMap<i32, Vec<SkuSale>> = std::collections::HashMap::new();
    for sale in evidence.sales {
        by_sku.entry(sale.sku).or_default().push(sale.clone());
    }
    for sales in by_sku.values_mut() {
        sales.sort_by_key(|s| ms(s.sold_at));
    }
    let (mut earlier, mut held_out) = (TimeInStock::default(), TimeInStock::default());
    let mut graded = Forecast::ALL.map(|forecast| {
        (
            forecast,
            TimeInStock::default(),
            [HorizonTally::default(); HORIZON_DAYS.len()],
        )
    });
    for price in evidence.prices {
        let listed = ms(price.listed_at);
        if price.quantity <= 0
            || price.forecast_median_sell_days <= 0.0
            || listed < evidence.from
            || listed >= evidence.through
        {
            continue;
        }
        let sku_sales = by_sku.get(&price.sku).map_or(&[][..], Vec::as_slice);
        let time = measure(price, sku_sales, evidence.through);
        if listed >= held_out_from {
            held_out = held_out.plus(&time);
        } else {
            earlier = earlier.plus(&time);
        }
        let outcomes =
            HORIZON_DAYS.map(|days| sold_within(price, sku_sales, days, evidence.through));
        for (forecast, graded_time, tallies) in &mut graded {
            let Some(median) = forecast.median_sell_days(price) else {
                continue;
            };
            *graded_time = graded_time.plus(&TimeInStock {
                forecast_sales: forecast_sales(time.in_stock_days, median),
                ..time
            });
            for ((tally, days), sold) in tallies.iter_mut().zip(HORIZON_DAYS).zip(outcomes) {
                if let Some(sold) = sold {
                    tally.add(
                        chance_sold_within(days, median),
                        chance_sold_within(days, price.forecast_median_sell_days),
                        sold,
                    );
                }
            }
        }
    }
    let earlier_ratio = earlier.actual_days_per_forecast_day();
    let held_out_check = if earlier.evidence() < MINIMUM_EARLIER_SALES
        || held_out.evidence() < MINIMUM_HELD_OUT_SALES
    {
        HeldOutCheck::TooFewSales
    } else if held_out.likelihood(earlier_ratio) > held_out.likelihood(1.0) {
        HeldOutCheck::Confirmed
    } else {
        HeldOutCheck::NotConfirmed
    };
    Calibration {
        seller_key: evidence.seller_key.to_owned(),
        learned_at: iso_ms(evidence.learned_at),
        evidence_window_days: evidence.evidence_window_days,
        from: iso_ms(evidence.from),
        held_out_from: iso_ms(held_out_from),
        through: iso_ms(evidence.through),
        earlier,
        held_out,
        earlier_actual_days_per_forecast_day: round_ratio(earlier_ratio),
        held_out_check,
        actual_days_per_forecast_day: round_ratio(
            earlier.plus(&held_out).actual_days_per_forecast_day(),
        ),
        grades: graded
            .into_iter()
            .map(|(forecast, time, tallies)| ForecastGrade {
                forecast,
                time_in_stock: time,
                actual_days_per_forecast_day: round_ratio(time.actual_days_per_forecast_day()),
                horizons: tallies
                    .iter()
                    .zip(HORIZON_DAYS)
                    .map(|(tally, days)| tally.score(days))
                    .collect(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: i64) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(ms).unwrap()
    }

    fn sale(sold_at: i64, quantity: i32) -> SkuSale {
        SkuSale {
            sku: 1,
            sold_at: at(sold_at),
            quantity,
        }
    }

    #[test]
    fn a_price_is_in_stock_until_it_sells_out() {
        let price = ListedPrice {
            sku: 1,
            listed_at: at(DAY_MS),
            replaced_at: None,
            quantity: 3,
            counted_at: at(0),
            forecast_median_sell_days: 2.0,
            buyer_choice_median_sell_days: None,
            condition_rate_median_sell_days: None,
            shrunk_rate_median_sell_days: None,
            shrunk_condition_rate_median_sell_days: None,
            quality_share_median_sell_days: None,
        };
        // One copy went before listing; two orders after it sell the rest.
        let sales = [
            sale(DAY_MS / 2, 1),
            sale(2 * DAY_MS, 1),
            sale(3 * DAY_MS, 1),
            sale(4 * DAY_MS, 1),
        ];
        let time = measure(&price, &sales, 10 * DAY_MS);
        assert_eq!(time.sales, 2.0);
        assert_eq!(time.in_stock_days, 2.0);
        assert_eq!(time.forecast_sales, 2.0 * std::f64::consts::LN_2 / 2.0);
        // Replaced before any sale: in stock until replaced.
        let replaced = ListedPrice {
            replaced_at: Some(at(DAY_MS + DAY_MS / 4)),
            ..price
        };
        assert_eq!(measure(&replaced, &sales, 10 * DAY_MS).in_stock_days, 0.25);
    }

    #[test]
    fn too_few_sales_are_not_checked() {
        let report = learn(&Evidence {
            seller_key: "s",
            prices: &[],
            sales: &[],
            from: 0,
            through: 28 * DAY_MS,
            learned_at: 28 * DAY_MS,
            evidence_window_days: 28,
        });
        assert_eq!(report.held_out_check, HeldOutCheck::TooFewSales);
        assert_eq!(report.held_out_from, iso_ms(21 * DAY_MS));
        assert_eq!(report.actual_days_per_forecast_day, 1.0);
        assert!(
            report
                .grades
                .iter()
                .all(|g| g.horizons.iter().all(|h| h.brier_score.is_none()))
        );
    }

    fn listed(sku: i32, shrunk: Option<f64>) -> ListedPrice {
        ListedPrice {
            sku,
            listed_at: at(0),
            replaced_at: None,
            quantity: 1,
            counted_at: at(0),
            forecast_median_sell_days: 14.0,
            buyer_choice_median_sell_days: None,
            condition_rate_median_sell_days: Some(7.0),
            shrunk_rate_median_sell_days: shrunk,
            shrunk_condition_rate_median_sell_days: None,
            quality_share_median_sell_days: None,
        }
    }

    #[test]
    fn each_forecast_is_graded_on_the_prices_published_with_it() {
        // Two prices listed on day 0 and followed through day 28: one sells on day 3, one never.
        let report = learn(&Evidence {
            seller_key: "s",
            prices: &[listed(1, Some(28.0)), listed(2, None)],
            sales: &[sale(3 * DAY_MS, 1)],
            from: 0,
            through: 28 * DAY_MS,
            learned_at: 28 * DAY_MS,
            evidence_window_days: 28,
        });
        let grade = |f: Forecast| report.grades.iter().find(|g| g.forecast == f).unwrap();
        let close =
            |a: Option<f64>, b: f64| assert!((a.unwrap() - b).abs() < 1e-12, "{a:?} vs {b}");
        assert_eq!(report.grades.len(), Forecast::ALL.len());
        assert_eq!(report.grades[0].forecast, Forecast::Curve);
        // The curve's grade is the window's calibration.
        let curve = grade(Forecast::Curve);
        assert_eq!(curve.time_in_stock, report.earlier.plus(&report.held_out));
        assert_eq!(
            curve.actual_days_per_forecast_day,
            report.actual_days_per_forecast_day
        );
        assert_eq!(
            curve
                .horizons
                .iter()
                .map(|h| h.horizon_days)
                .collect::<Vec<_>>(),
            HORIZON_DAYS
        );
        // An even chance at 14 days, one sold: a Brier score of a quarter.
        let fourteen = curve.horizons[0];
        assert_eq!(fourteen.listings, 2.0);
        close(fourteen.sold_share, 0.5);
        close(fourteen.forecast_sold_share, 0.5);
        close(fourteen.brier_score, 0.25);
        assert_eq!(fourteen.brier_score, fourteen.curve_brier_score);
        close(
            curve.horizons[2].brier_score,
            (0.25f64.powi(2) + 0.75f64.powi(2)) / 2.0,
        );
        // A forecast is graded only on the prices published with it, beside the curve on those.
        let shrunk = grade(Forecast::ShrunkRate);
        assert_eq!(shrunk.time_in_stock.listings, 1.0);
        assert_eq!(shrunk.horizons[0].listings, 1.0);
        close(shrunk.horizons[0].brier_score, 0.5);
        close(shrunk.horizons[0].curve_brier_score, 0.25);
        close(
            grade(Forecast::ConditionRate).horizons[0].brier_score,
            (0.25f64.powi(2) + 0.75f64.powi(2)) / 2.0,
        );
        let none = grade(Forecast::BuyerChoice);
        assert_eq!(none.time_in_stock.listings, 0.0);
        assert_eq!(
            (none.horizons[0].listings, none.horizons[0].brier_score),
            (0.0, None)
        );
    }

    #[test]
    fn the_quality_aware_share_is_graded_beside_the_curve_on_its_own_prices() {
        // One price carries the quality-aware share and sells on day 3; one carries none and never
        // sells.
        let carried = ListedPrice {
            quality_share_median_sell_days: Some(7.0),
            ..listed(1, None)
        };
        let report = learn(&Evidence {
            seller_key: "s",
            prices: &[carried, listed(2, None)],
            sales: &[sale(3 * DAY_MS, 1)],
            from: 0,
            through: 28 * DAY_MS,
            learned_at: 28 * DAY_MS,
            evidence_window_days: 28,
        });
        assert_eq!(report.grades.len(), 6);
        let grade = report.grades.last().unwrap();
        assert_eq!(grade.forecast, Forecast::QualityShare);
        assert_eq!(grade.time_in_stock.listings, 1.0);
        assert_eq!(grade.time_in_stock.sales, 1.0);
        // Sold on day 3: in stock three days, at ln 2 / 7 sales a day.
        assert!(
            (grade.time_in_stock.forecast_sales - 3.0 * std::f64::consts::LN_2 / 7.0).abs() < 1e-12
        );
        // A median of 7 days gives three chances in four of a sale within 14; the curve's 14, one in
        // two.
        let fourteen = grade.horizons[0];
        assert_eq!((fourteen.horizon_days, fourteen.listings), (14, 1.0));
        assert!((fourteen.brier_score.unwrap() - 0.0625).abs() < 1e-12);
        assert!((fourteen.curve_brier_score.unwrap() - 0.25).abs() < 1e-12);
        assert_eq!(
            serde_json::to_value(grade.forecast).unwrap(),
            serde_json::json!("qualityShare")
        );
    }

    #[test]
    fn a_horizon_is_scored_only_when_the_evidence_covers_it() {
        let sales = [sale(3 * DAY_MS, 1)];
        let through = 28 * DAY_MS;
        assert_eq!(
            sold_within(&listed(1, None), &sales, 14, through),
            Some(true)
        );
        assert_eq!(sold_within(&listed(1, None), &[], 14, through), Some(false));
        // A later price does not end the horizon of the forecasts published with this one.
        let replaced = ListedPrice {
            replaced_at: Some(at(DAY_MS)),
            ..listed(1, None)
        };
        assert_eq!(sold_within(&replaced, &sales, 14, through), Some(true));
        let late = ListedPrice {
            listed_at: at(20 * DAY_MS),
            ..listed(1, None)
        };
        assert_eq!(sold_within(&late, &sales, 14, through), None);
        let sold_out = ListedPrice {
            quantity: 0,
            ..listed(1, None)
        };
        assert_eq!(sold_within(&sold_out, &sales, 14, through), None);
    }
}
