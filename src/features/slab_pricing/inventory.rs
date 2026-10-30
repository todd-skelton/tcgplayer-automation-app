//! The seller's eBay listings the slab pricer knows, a page at a time
//! (`/api/slab-inventory`, the Node app's, which also says what each needs reviewed).
use serde::{Deserialize, Serialize};

use super::identity::{Candidate, SlabIdentity};
use crate::legacy::Legacy;

/// Listings a page, as the React panel read them.
pub const PAGE_SIZE: u32 = 25;

#[derive(Debug, Deserialize)]
pub struct InventoryPage {
    pub items: Vec<Listing>,
    pub next: Option<String>,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub id: String,
    pub seller: String,
    pub revision: i64,
    pub state: String,
    pub url: String,
    pub snapshot: Snapshot,
    #[serde(default)]
    pub identity_id: Option<String>,
    #[serde(default)]
    pub identity: Option<ListingIdentity>,
    #[serde(default)]
    pub review_reasons: Vec<String>,
    pub observed_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub item_id: String,
    pub title: String,
    pub price: Price,
    pub shipping: Shipping,
    #[serde(default)]
    pub certificate: Option<Certificate>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Price {
    pub amount: f64,
    pub currency: String,
}

/// What the listing charges for shipping, when it says.
#[derive(Clone, Debug, Deserialize)]
pub struct Shipping {
    pub amount: Option<f64>,
    pub currency: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    pub grader: String,
    pub certificate_number: String,
}

/// The identity the listing is tied to, as the inventory read joins it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListingIdentity {
    pub grader: String,
    pub certificate_number: String,
    #[serde(default)]
    pub candidate: Option<Candidate>,
    #[serde(default)]
    pub identity: Option<SlabIdentity>,
}

impl Listing {
    /// The listing's ask in USD, the currency the recommendation is calculated in.
    pub fn ask_in_usd(&self) -> Option<f64> {
        let price = &self.snapshot.price;
        (price.currency == "USD").then_some(price.amount)
    }

    /// The shipping it charges in USD, when it says.
    pub fn shipping_in_usd(&self) -> Option<f64> {
        let shipping = &self.snapshot.shipping;
        shipping
            .amount
            .filter(|_| shipping.currency.as_deref() == Some("USD"))
    }

    /// `PSA 10`, or "Unresolved" until a certificate names the grade.
    pub fn owned_grade(&self) -> String {
        self.identity
            .as_ref()
            .and_then(|i| {
                i.identity
                    .as_ref()
                    .or(i.candidate.as_ref().map(|c| &c.identity))
            })
            .map(|i| format!("{} {}", i.grading.grader, i.grading.encoding))
            .unwrap_or_else(|| "Unresolved".into())
    }
}

/// One page of the seller's listings, after the listing `after` (none for the first).
pub async fn page(legacy: &Legacy, seller: &str, after: &str) -> Result<InventoryPage, String> {
    #[derive(Serialize)]
    struct Query<'a> {
        seller: &'a str,
        after: &'a str,
        limit: u32,
    }
    legacy
        .read_with(
            "/api/slab-inventory",
            &Query {
                seller,
                after,
                limit: PAGE_SIZE,
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_names_its_owned_grade_once_a_certificate_does() {
        let listing: Listing = serde_json::from_str(
            r#"{"id":"1","seller":"pokebash","revision":2,"state":"active","url":"https://www.ebay.com/itm/9",
                "snapshot":{"itemId":"123456789","title":"Charizard PSA 9","price":{"amount":420.5,"currency":"USD"},
                    "shipping":{"amount":5,"currency":"USD","policyId":null},"certificate":null},
                "identityId":null,"identity":null,"reviewReasons":["identity-required"],
                "observedAt":"2026-10-30T12:00:00.000Z"}"#,
        )
        .unwrap();
        assert_eq!(listing.owned_grade(), "Unresolved");
        assert_eq!(listing.ask_in_usd(), Some(420.5));
        assert_eq!(listing.shipping_in_usd(), Some(5.0));
        let tied: ListingIdentity = serde_json::from_str(
            r#"{"grader":"PSA","certificateNumber":"5","candidate":null,"identity":{"card":{"name":"Charizard"},"grading":{"grader":"PSA","encoding":"9","number":9,"label":"MINT","qualifier":null,"autograph":null}}}"#,
        )
        .unwrap();
        let listing = Listing {
            identity: Some(tied),
            ..listing
        };
        assert_eq!(listing.owned_grade(), "PSA 9");
    }
}
