//! Sell-time forecast calibration (`features/forecast-calibration`): how the continuous pricing
//! seller's listings sold against the sell-time forecasts they were published with, over a
//! trailing window that ends where the latest complete order history sync ends. The latest
//! quarter of the window is held out to check the rate measured before it.
//!
//! Times are whole milliseconds, as the Node app's dates hold them, so the report reads to the
//! same figures.
mod evidence;

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

/// `measureListedPrice`: one price's time in stock, from listing until it was replaced, sold
/// out or the evidence ends, given the SKU's sales in time order. Each order is one buyer
/// arriving, whatever it bought, and the forecast expects ln 2 / median of them per day.
pub fn measure(price: &ListedPrice, sales: &[SkuSale], through: i64) -> TimeInStock {
    let counted_at = ms(price.counted_at);
    let start = ms(price.listed_at) as f64;
    let replaced = price.replaced_at.map_or(f64::INFINITY, |at| ms(at) as f64);
    let end = start.max(replaced.min(through as f64));
    let sold_before_listing: i64 = sales
        .iter()
        .filter(|s| ms(s.sold_at) >= counted_at && (ms(s.sold_at) as f64) < start)
        .map(|s| i64::from(s.quantity))
        .sum();
    let mut in_stock = i64::from(price.quantity) - sold_before_listing;
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
        forecast_sales: (in_stock_days * std::f64::consts::LN_2) / price.forecast_median_sell_days,
    }
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
    for price in evidence.prices {
        let listed = ms(price.listed_at);
        if price.quantity <= 0
            || price.forecast_median_sell_days <= 0.0
            || listed < evidence.from
            || listed >= evidence.through
        {
            continue;
        }
        let time = measure(
            price,
            by_sku.get(&price.sku).map_or(&[], Vec::as_slice),
            evidence.through,
        );
        if listed >= held_out_from {
            held_out = held_out.plus(&time);
        } else {
            earlier = earlier.plus(&time);
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
    }

    /// Node's reports for each window at one time, on the dev database
    /// (`.port-logs/forecast-calibration-node.ts`): the same, figure for figure.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's reports in .port-logs"]
    async fn reports_learn_as_node_learns_them() {
        crate::config::load_env();
        let db = crate::database::Database::connect_lazy(&crate::config::database_url());
        let node: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/forecast-calibration.node.json").unwrap(),
        )
        .unwrap();
        let now: DateTime<Utc> = node["at"].as_str().unwrap().parse().unwrap();
        for days in WINDOW_DAYS {
            let theirs = &node[days.to_string()];
            match load(&db, days, now).await {
                Ok(ours) => {
                    let theirs: Calibration = serde_json::from_value(theirs.clone()).unwrap();
                    assert_eq!(ours, theirs, "{days} days");
                }
                Err(ours) => assert_eq!(
                    ours,
                    theirs["error"].as_str().unwrap_or_default(),
                    "{days} days"
                ),
            }
        }
    }
}
