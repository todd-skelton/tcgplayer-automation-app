//! One product's prices by condition and variant (`/api/product-price-matrix`, the Node app's):
//! TCGplayer's market and sales, the store's listing, and, when asked, what the active pricing
//! policy would sell at, with the sell-at and market prices clamped so no condition sits above a
//! better one (`conditionLadder.ts`). The refund for a condition dispute is worked out here
//! (`estimateRefund`) and, as the operator changes it, in the browser.
use serde::{Deserialize, Serialize};

use super::products::Product;
use crate::legacy::Legacy;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    #[serde(default)]
    pub variants: Vec<String>,
    pub cells: Vec<Cell>,
    pub suggested_prices_included: bool,
    #[serde(default)]
    pub policy: Option<Policy>,
    #[serde(default)]
    pub listings_included: bool,
    pub priced_at: String,
}

/// The store's own listing of a SKU.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub price: Option<f64>,
    pub quantity: i64,
    pub in_stock: bool,
}

/// One SKU: a condition of a variant.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub condition: String,
    pub variant: String,
    pub tcg_market_price: Option<f64>,
    pub lowest_sale_price: Option<f64>,
    pub highest_sale_price: Option<f64>,
    #[serde(default)]
    pub sale_count: u64,
    pub listing: Option<Listing>,
    /// What the store would list at: the active policy's price after the floor.
    pub sell_at_price: Option<f64>,
    /// The sell-at price clamped so no condition sits above a better one.
    pub ladder_price: Option<f64>,
    /// The market price clamped the same way.
    pub market_ladder_price: Option<f64>,
    #[serde(default)]
    pub above_better_condition: bool,
    pub estimated_time_to_sell_days: Option<f64>,
    pub pricing_decision: Option<Decision>,
    /// The percentile policy's decision beside the active one, when they differ.
    pub shadow_pricing_decision: Option<Decision>,
    pub condition_normalization: Option<Normalization>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

impl Cell {
    /// The price a buyer most likely paid: the in-stock listing, else the sell-at price, else
    /// market.
    pub fn likely_paid(&self) -> Option<f64> {
        self.listing
            .as_ref()
            .filter(|l| l.in_stock && l.quantity > 0)
            .and_then(|l| l.price)
            .or(self.sell_at_price)
            .or(self.tcg_market_price)
    }

    /// How long it is expected to take to sell at its sell-at price, when the curve modeled it.
    pub fn modeled_days(&self) -> Option<f64> {
        self.pricing_decision
            .as_ref()
            .filter(|d| d.basis == "modeled")
            .and(self.estimated_time_to_sell_days)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    Percentile,
    TargetHorizon,
    ProfitPerDay,
}

impl Method {
    /// The policy's name as a column heading.
    pub fn label(self) -> &'static str {
        match self {
            Method::Percentile => "Percentile policy",
            Method::TargetHorizon => "Target horizon",
            Method::ProfitPerDay => "Profit per day",
        }
    }
}

/// How a price was chosen.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub method: Method,
    pub selected_price: f64,
    pub equivalent_percentile: Option<f64>,
    pub configured_percentile: Option<f64>,
    pub target_horizon_days: Option<f64>,
    pub daily_return_hurdle: Option<f64>,
    #[serde(default)]
    pub unprofitable: bool,
    pub estimated_median_sell_days: Option<f64>,
    /// `none`, `floor` or `current-price`.
    pub constraint: String,
    /// `modeled`, or where the price came from when the curve did not model it.
    pub basis: String,
}

impl Decision {
    /// The rule it followed: "65th percentile", "7.5 days target", "0.50%/day hurdle".
    pub fn rule(&self) -> String {
        match self.method {
            Method::Percentile => match self.configured_percentile {
                Some(p) => format!("{} percentile", ordinal(p)),
                None => "Percentile".into(),
            },
            Method::TargetHorizon => format!("{} target", days(self.target_horizon_days)),
            Method::ProfitPerDay => {
                format!("{} hurdle", hurdle(self.daily_return_hurdle.unwrap_or(0.0)))
            }
        }
    }

    /// Where the price came from when it was not modeled: "market reference".
    pub fn basis(&self) -> String {
        self.basis.replace('-', " ")
    }

    pub fn modeled(&self) -> bool {
        self.basis == "modeled"
    }
}

/// The policy the sell-at prices came from.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Policy {
    Percentile,
    TargetHorizon { horizon_days: f64 },
    ProfitPerDay { daily_return_hurdle: f64 },
}

impl Policy {
    pub fn describe(&self) -> String {
        match self {
            Policy::Percentile => "Configured percentile per product line".into(),
            Policy::TargetHorizon { horizon_days } => {
                format!("Target horizon of {}", days(Some(*horizon_days)))
            }
            Policy::ProfitPerDay {
                daily_return_hurdle,
            } => format!(
                "Profit per day at a {} hurdle",
                hurdle(*daily_return_hurdle)
            ),
        }
    }
}

/// What stood in for a condition's own market data.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Normalization {
    pub method: String,
    pub anchor_condition: Option<String>,
}

/// "7.5 days", "120 days", or "N/A" without a value (`formatDays`).
pub fn days(days: Option<f64>) -> String {
    match days.filter(|d| d.is_finite()) {
        None => "N/A".into(),
        Some(d) if d >= 100.0 => format!("{} days", grouped(d.round() as i64)),
        Some(d) => {
            let tenths = (d * 10.0).round() / 10.0;
            if tenths.fract() == 0.0 {
                format!("{} days", tenths as i64)
            } else {
                format!("{tenths} days")
            }
        }
    }
}

/// `1234` as `1,234`, as `toLocaleString` writes it in English.
fn grouped(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// "0.50%/day".
fn hurdle(daily_return: f64) -> String {
    format!("{:.2}%/day", daily_return * 100.0)
}

/// "65th", "1st", "12th".
pub fn ordinal(percentile: f64) -> String {
    let n = percentile.round() as i64;
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// The refund that leaves the buyer paying what the received condition would sell for, and
/// what they keep paying. Never negative; none without a positive price paid and price for the
/// received condition.
#[derive(Debug, PartialEq)]
pub struct Refund {
    pub refund: f64,
    pub net: f64,
}

fn cents(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn refund(paid: Option<f64>, received: Option<f64>) -> Option<Refund> {
    let positive = |v: Option<f64>| v.filter(|v| v.is_finite() && *v > 0.0);
    let (paid, received) = (positive(paid)?, positive(received)?);
    let refund = cents((paid - received).max(0.0));
    Some(Refund {
        refund,
        net: cents(paid - refund),
    })
}

pub async fn matrix(
    legacy: &Legacy,
    product: &Product,
    language: Option<&str>,
    suggested: bool,
) -> Result<Matrix, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        product_id: i32,
        product_line_id: i32,
        language: Option<&'a str>,
        include_suggested_prices: bool,
    }
    legacy
        .send(
            "/api/product-price-matrix",
            &Request {
                product_id: product.product_id,
                product_line_id: product.product_line_id,
                language,
                include_suggested_prices: suggested,
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `conditionLadder.test.ts`'s refund cases.
    #[test]
    fn a_refund_leaves_the_buyer_paying_what_they_received() {
        assert_eq!(
            refund(Some(48.61), Some(34.99)),
            Some(Refund {
                refund: 13.62,
                net: 34.99
            })
        );
        assert_eq!(
            refund(Some(12.0), Some(12.5)),
            Some(Refund {
                refund: 0.0,
                net: 12.0
            })
        );
        assert_eq!(refund(None, Some(6.0)), None);
        assert_eq!(refund(Some(5.0), Some(0.0)), None);
    }

    #[test]
    fn labels_read_as_the_react_screen_wrote_them() {
        assert_eq!(days(Some(7.46)), "7.5 days");
        assert_eq!(days(Some(7.0)), "7 days");
        assert_eq!(days(Some(1234.4)), "1,234 days");
        assert_eq!(days(None), "N/A");
        assert_eq!(
            [1.0, 2.0, 3.0, 11.0, 12.4, 22.0, 65.0].map(ordinal),
            ["1st", "2nd", "3rd", "11th", "12th", "22nd", "65th"]
        );
        let policy: Policy = serde_json::from_value(
            serde_json::json!({ "method": "profit-per-day", "dailyReturnHurdle": 0.005 }),
        )
        .unwrap();
        assert_eq!(policy.describe(), "Profit per day at a 0.50%/day hurdle");
        let policy: Policy = serde_json::from_value(
            serde_json::json!({ "method": "target-horizon", "horizonDays": 30 }),
        )
        .unwrap();
        assert_eq!(policy.describe(), "Target horizon of 30 days");
    }
}
