//! The owned slab's recommendation: a market range from the saved sold evidence, and an item ask
//! from the seller's costs. Calculating and reviewing one stay the Node app's
//! (`/api/slab-recommendations`, from saved evidence only, never a provider); the latest is read
//! with the research (`/api/slab-workspace`).
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// The valuation policy the React screen sent, with the comparable price basis chosen. The
/// same values as `DEFAULT_SLAB_POLICY` in `app/features/ebay-slab-pricing/valuation/slabValuation.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy<'a> {
    currency: &'static str,
    basis: &'a str,
    minimum_comps: u32,
    minimum_effective_count: f64,
    half_life_days: u32,
    maximum_age_days: u32,
    rounding_increment: f64,
    review_change_fraction: f64,
    review_spread_ratio: f64,
}

impl Policy<'_> {
    pub fn with_basis(basis: &str) -> Policy<'_> {
        Policy {
            currency: "USD",
            basis,
            minimum_comps: 3,
            minimum_effective_count: 2.5,
            half_life_days: 90,
            maximum_age_days: 365,
            rounding_increment: 0.01,
            review_change_fraction: 0.25,
            review_spread_ratio: 4.0,
        }
    }
}

/// The comparable price basis, as the select and the policy write it.
pub const BASES: [(&str, &str); 2] = [
    ("item-plus-shipping", "Item + shipping"),
    ("item-only", "Item only"),
];

/// A saved recommendation, whether it still matches its identity, decisions and evidence
/// (`current`), and the ask the operator reviewed, if any.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub id: String,
    pub calculation: Calculation,
    pub current: bool,
    pub r#override: Option<Override>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Override {
    pub item_price: f64,
    pub currency: String,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Calculation {
    pub identity: Revisioned,
    pub policy: Basis,
    pub seller: Seller,
    pub market: Market,
    pub ask: Ask,
    pub dispositions: Vec<Disposition>,
    pub evidence: Vec<Used>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Revisioned {
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Basis {
    pub basis: String,
}

/// The seller's costs the ask was proposed from. Missing ones were unknown.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seller {
    pub current_ask: Option<f64>,
    pub shipping_charged: Option<f64>,
    pub shipping_cost: Option<f64>,
    pub acquisition_cost: Option<f64>,
    pub minimum_ask: Option<f64>,
    pub minimum_profit: Option<f64>,
    pub fees: Option<Fees>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Fees {
    /// A fraction: 0.1325 for 13.25%.
    pub rate: f64,
    pub fixed: f64,
    pub basis: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub basis: String,
    pub as_of: String,
    pub range: Option<Span>,
    pub observed_span: Option<Span>,
    pub count: u32,
    pub effective_count: f64,
    pub comps: Vec<Comp>,
    pub excluded: Vec<Excluded>,
    pub flags: Vec<Flag>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Span {
    pub low: f64,
    pub high: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Comp {
    pub date: String,
    pub amount: f64,
    pub currency: String,
    pub weight: f64,
    pub references: Vec<Reference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub provider: String,
    pub provider_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Excluded {
    pub key: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Flag {
    pub code: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub proposed_item_ask: Option<f64>,
    pub estimated_proceeds: Option<f64>,
    pub estimated_profit: Option<f64>,
    pub flags: Vec<Flag>,
    pub requires_review: bool,
}

/// A sold event the calculation left out or could not be sure of.
#[derive(Clone, Debug, Deserialize)]
pub struct Disposition {
    /// `needs-review` or `rejected`.
    pub status: String,
    pub reasons: Vec<String>,
    pub references: Vec<Reference>,
}

/// An evidence revision the calculation read.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Used {
    pub revision_id: String,
}

impl Recommendation {
    /// It needs calculating again: its identity, comp decisions or evidence changed (the Node
    /// app's `current`), or newer evidence is saved than it read (`latest`, when the owned
    /// grade is shown and could be calculated).
    pub fn stale(&self, latest: Option<&BTreeSet<String>>) -> bool {
        let read: BTreeSet<&str> = self
            .calculation
            .evidence
            .iter()
            .map(|e| e.revision_id.as_str())
            .collect();
        !self.current
            || latest
                .is_some_and(|latest| !latest.iter().map(String::as_str).eq(read.iter().copied()))
    }

    /// The codes of the market's and the ask's flags, each once, in order.
    pub fn flags(&self) -> Vec<&str> {
        let mut seen = BTreeSet::new();
        let c = &self.calculation;
        c.market
            .flags
            .iter()
            .chain(&c.ask.flags)
            .map(|f| f.code.as_str())
            .filter(|code| seen.insert(*code))
            .collect()
    }

    /// How many events the calculation was unsure of, and how many it left out.
    pub fn uncertain_and_rejected(&self) -> (usize, usize) {
        let d = &self.calculation.dispositions;
        let count = |status| d.iter().filter(|x| x.status == status).count();
        (count("needs-review"), count("rejected"))
    }
}

/// `USD 12.30` as the React screen wrote an amount, or "Unknown".
pub fn amount(value: Option<f64>) -> String {
    value.map_or_else(|| "Unknown".into(), |v| format!("USD {v:.2}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(current: bool, read: &[&str]) -> Recommendation {
        serde_json::from_value(serde_json::json!({
            "id": "r", "current": current, "override": null,
            "calculation": {
                "identity": { "revision": 1 }, "policy": { "basis": "item-only" }, "seller": {},
                "market": { "basis": "item-only", "asOf": "2026-10-30T00:00:00Z", "range": null,
                    "observedSpan": null, "count": 0, "effectiveCount": 0, "comps": [], "excluded": [],
                    "flags": [{ "code": "insufficient-comps" }] },
                "ask": { "proposedItemAsk": null, "estimatedProceeds": null, "estimatedProfit": null,
                    "flags": [{ "code": "insufficient-comps" }, { "code": "no-floor" }], "requiresReview": true },
                "dispositions": [],
                "evidence": read.iter().map(|id| serde_json::json!({ "revisionId": id })).collect::<Vec<_>>()
            }
        }))
        .unwrap()
    }

    #[test]
    fn a_recommendation_is_stale_when_newer_evidence_is_saved() {
        let latest: BTreeSet<String> = ["a".into(), "b".into()].into();
        assert!(!saved(true, &["b", "a"]).stale(Some(&latest)));
        assert!(saved(true, &["a"]).stale(Some(&latest)));
        assert!(!saved(true, &["a"]).stale(None));
        assert!(saved(false, &["a", "b"]).stale(Some(&latest)));
    }

    #[test]
    fn flags_are_listed_once() {
        assert_eq!(saved(true, &[]).flags(), ["insufficient-comps", "no-floor"]);
        assert_eq!(amount(Some(12.3)), "USD 12.30");
        assert_eq!(amount(None), "Unknown");
    }
}
