//! The price a suggestion is listed at: never under the floor below the market price, unless the
//! SKU's own recent sales or asks show it sells lower. `calculateMarketplacePrice`.
use serde::{Deserialize, Serialize};

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
}
