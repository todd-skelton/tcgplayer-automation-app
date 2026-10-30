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
}

#[derive(Clone, Debug, Deserialize)]
pub struct Snapshot {
    pub title: String,
    pub price: Price,
    #[serde(default)]
    pub certificate: Option<Certificate>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Price {
    pub amount: f64,
    pub currency: String,
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
                "snapshot":{"title":"Charizard PSA 9","price":{"amount":420.5,"currency":"USD"},"certificate":null},
                "identityId":null,"identity":null,"reviewReasons":["identity-required"]}"#,
        )
        .unwrap();
        assert_eq!(listing.owned_grade(), "Unresolved");
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
