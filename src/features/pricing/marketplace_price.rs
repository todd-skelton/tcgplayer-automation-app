//! The price a suggestion is listed at: never under the floor below the market price, unless the
//! SKU's own recent sales or asks show it sells lower. `calculateMarketplacePrice`.
use serde::{Deserialize, Serialize};

use super::policy::Basis;
use crate::features::inventory_economics::ledger::assumptions::{js_round, js_to_fixed};

/// The SKU's own evidence that its price may go under the market floor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEvidence {
    /// Lowest effective sale price of this exact SKU in the last 90 days.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_condition_low_sale_price: Option<f64>,
    /// Second-cheapest delivered ask from another seller of this exact SKU.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub second_cheapest_ask_price: Option<f64>,
}

/// The floor: a share of the market price less a constant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Floor {
    pub min_price_multiplier: f64,
    pub min_price_constant: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The suggestion is listed as it is.
    Suggested,
    /// No market price, so nothing bounds the suggestion.
    NoMarketPrice,
    /// The suggestion was under the floor, so the floor is listed.
    Floored,
}

impl Outcome {
    /// The warning the pricer records, in the Node app's words.
    pub fn warning(self) -> &'static str {
        match self {
            Outcome::Suggested => "",
            Outcome::NoMarketPrice => "No market price available. Using suggested price directly.",
            Outcome::Floored => "Suggested price below minimum. Using minimum price.",
        }
    }
}

/// The listed price for a suggestion, and what decided it.
pub fn marketplace_price(
    suggested: f64,
    market_price: Option<f64>,
    floor: Floor,
    evidence: PriceEvidence,
) -> (f64, Outcome) {
    let market = market_price
        .filter(|price| *price != 0.0 && !price.is_nan())
        .unwrap_or(0.0);
    if suggested > 0.0 && market == 0.0 {
        return (suggested, Outcome::NoMarketPrice);
    }
    if suggested > 0.0 {
        let lower_bound = [
            evidence.own_condition_low_sale_price,
            evidence.second_cheapest_ask_price,
        ]
        .into_iter()
        .flatten()
        .filter(|price| *price > 0.0)
        .fold(
            market * floor.min_price_multiplier - floor.min_price_constant,
            f64::min,
        );
        if suggested < lower_bound {
            return (lower_bound, Outcome::Floored);
        }
    }
    (suggested, Outcome::Suggested)
}

/// What a SKU without a modeled price is priced from.
#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    pub price: f64,
    pub basis: Basis,
    pub warning: String,
}

/// `Math.round((value + Number.EPSILON) * 100) / 100` for a finite positive price; none otherwise.
fn positive_cents(value: Option<f64>) -> Option<f64> {
    value
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| js_round((v + f64::EPSILON) * 100.0) as f64 / 100.0)
}

/// `calculateInsufficientSalesFallback`: the higher of the market price and the lowest delivered
/// listing, else the current price, else nothing.
pub fn insufficient_sales_fallback(
    market_price: Option<f64>,
    lowest_listing_price: Option<f64>,
    current_price: Option<f64>,
) -> Option<Reference> {
    let market = positive_cents(market_price);
    let listing = positive_cents(lowest_listing_price);
    if market.is_some() || listing.is_some() {
        let price = market.unwrap_or(0.0).max(listing.unwrap_or(0.0));
        let references: Vec<String> = [
            market.map(|p| format!("TCG market ${}", js_to_fixed(p, 2))),
            listing.map(|p| format!("lowest delivered listing ${}", js_to_fixed(p, 2))),
        ]
        .into_iter()
        .flatten()
        .collect();
        return Some(Reference {
            price,
            basis: match (market, listing) {
                (Some(_), Some(_)) => Basis::MarketAndListingReference,
                (Some(_), None) => Basis::MarketReference,
                _ => Basis::ListingReference,
            },
            warning: format!(
                "Insufficient sales history. Using the highest available reference price ({}): ${}.",
                references.join(", "),
                js_to_fixed(price, 2)
            ),
        });
    }
    let current = positive_cents(current_price)?;
    Some(Reference {
        price: current,
        basis: Basis::CurrentPrice,
        warning: format!(
            "Insufficient sales history and no market price or listing is available. Keeping the current price at ${}.",
            js_to_fixed(current, 2)
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOB: Floor = Floor {
        min_price_multiplier: 0.75,
        min_price_constant: 0.25,
    };

    #[test]
    fn the_floor_holds_unless_the_skus_own_evidence_lowers_it() {
        let default = Floor {
            min_price_multiplier: 80.0 / 85.0,
            min_price_constant: 0.1,
        };
        assert_eq!(
            marketplace_price(5.0, Some(10.0), default, PriceEvidence::default()),
            (10.0 * (80.0 / 85.0) - 0.1, Outcome::Floored)
        );
        assert_eq!(
            marketplace_price(5.0, Some(10.0), JOB, PriceEvidence::default()),
            (7.25, Outcome::Floored)
        );
        let ask = PriceEvidence {
            second_cheapest_ask_price: Some(6.0),
            ..PriceEvidence::default()
        };
        assert_eq!(
            marketplace_price(5.0, Some(10.0), JOB, ask),
            (6.0, Outcome::Floored)
        );
        let sale = PriceEvidence {
            own_condition_low_sale_price: Some(4.0),
            second_cheapest_ask_price: Some(6.0),
        };
        assert_eq!(
            marketplace_price(5.0, Some(10.0), JOB, sale),
            (5.0, Outcome::Suggested)
        );
        assert_eq!(
            marketplace_price(5.0, None, JOB, ask),
            (5.0, Outcome::NoMarketPrice),
            "evidence lowers the market floor but never creates one"
        );
        assert_eq!(
            marketplace_price(0.05, Some(0.05), default, PriceEvidence::default()),
            (0.05, Outcome::Suggested),
            "a market price too small to bound anything is not a missing one"
        );
        assert_eq!(
            Outcome::Floored.warning(),
            "Suggested price below minimum. Using minimum price."
        );
    }
    #[test]
    fn insufficient_sales_use_the_higher_reference_else_the_current_price() {
        let listing_wins =
            insufficient_sales_fallback(Some(10.0), Some(12.34), Some(20.0)).unwrap();
        assert_eq!(listing_wins.price, 12.34);
        assert_eq!(listing_wins.basis, Basis::MarketAndListingReference);
        assert_eq!(
            listing_wins.warning,
            "Insufficient sales history. Using the highest available reference price (TCG market $10.00, lowest delivered listing $12.34): $12.34."
        );
        let market_wins = insufficient_sales_fallback(Some(15.67), Some(12.0), Some(20.0)).unwrap();
        assert_eq!(market_wins.price, 15.67);
        let listing = insufficient_sales_fallback(None, Some(8.25), None).unwrap();
        assert_eq!(
            (listing.price, listing.basis),
            (8.25, Basis::ListingReference)
        );
        let market = insufficient_sales_fallback(Some(9.5), None, None).unwrap();
        assert_eq!((market.price, market.basis), (9.5, Basis::MarketReference));
        let current = insufficient_sales_fallback(None, Some(0.0), Some(4.99)).unwrap();
        assert_eq!((current.price, current.basis), (4.99, Basis::CurrentPrice));
        assert!(
            current
                .warning
                .contains("Keeping the current price at $4.99.")
        );
        assert_eq!(insufficient_sales_fallback(None, None, Some(-1.0)), None);
    }
}
