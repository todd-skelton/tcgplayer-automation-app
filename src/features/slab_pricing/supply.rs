//! Active supply for the slab researched: the unsold listings a provider reports, screened
//! against the identity (equivalent, potential match, excluded), with the lowest delivered asks.
//! Context only: it never changes the recommendation. Reading and refreshing stay the Node app's
//! (`/api/slab-supply`, whose worker calls eBay and Alt).
use serde::{Deserialize, Serialize};

use super::research::{EvidenceStatus, Window};
use crate::legacy::Legacy;

/// Supply rows a page, as the Node app pages them.
pub const ROWS: u32 = 50;

/// The seller whose own listings are left out of supply when no listing is reviewed.
pub const DEFAULT_SELLER: &str = "pokebash";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Supply {
    pub identity_revision: i64,
    pub statuses: Vec<EvidenceStatus>,
    pub selected_key: Option<String>,
    pub known_own_listings: u32,
    pub context: Option<Context>,
    pub changes: Option<Changes>,
    pub page: Option<Page>,
    pub source_has_more_pages: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub captured_at: String,
    pub reported_count: u32,
    /// The snapshot is old or its last refresh failed: its asks are not counted as competition.
    pub stale: bool,
    pub rows: Vec<Row>,
    pub equivalent_listings: u32,
    pub potential_listings: u32,
    pub excluded_listings: u32,
    pub lowest_equivalent_delivered_ask: Option<f64>,
    pub lowest_potential_delivered_ask: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub key: String,
    pub listing: Listing,
    /// `equivalent`, `potential-match` or `excluded`.
    pub status: String,
    pub reasons: Vec<String>,
    pub delivered_ask: Option<f64>,
    pub listing_age_days: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub title: Option<String>,
    pub provider_id: String,
    pub source_url: Option<String>,
    pub price: Option<Money>,
    /// `ask`, `bid` or `unknown`.
    pub price_kind: String,
    pub shipping: Option<Money>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Money {
    pub amount: f64,
    pub currency: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub observed_from: String,
    pub observed_through: String,
    pub changes: Vec<Change>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Change {
    pub key: String,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub offset: u32,
    pub total: u32,
    pub next_offset: Option<u32>,
}

impl Supply {
    pub fn pending(&self) -> bool {
        self.statuses.iter().any(EvidenceStatus::pending)
    }

    /// The saved revision of the source shown, which the next source page is fetched after.
    pub fn selected_revision(&self) -> Option<&str> {
        let key = self.selected_key.as_deref()?;
        self.statuses
            .iter()
            .find(|s| s.key == key)
            .and_then(|s| s.latest_revision.as_deref())
    }
}

impl Row {
    /// `3 days`, `<1 day`, or "Unknown", as the React grid wrote a listing's age.
    pub fn age(&self) -> String {
        match self.listing_age_days {
            None => "Unknown".into(),
            Some(days) if days < 1.0 => "<1 day".into(),
            Some(days) => format!("{} days", days.floor()),
        }
    }
}

/// `USD 12.30`, `Unknown currency 12.30`, or "Unknown", as the React panel wrote a price.
pub fn money(value: Option<&Money>) -> String {
    match value {
        None => "Unknown".into(),
        Some(m) => format!(
            "{} {:.2}",
            m.currency.as_deref().unwrap_or("Unknown currency"),
            m.amount
        ),
    }
}

/// Which supply to read: the slab at a grade and dates, the seller whose own listings are left
/// out, the source chosen (none for the default), and the first row of the page.
pub struct Asked<'a> {
    pub id: &'a str,
    pub grade: &'a str,
    pub window: &'a Window,
    pub seller: &'a str,
    pub source: Option<&'a str>,
    pub offset: u32,
}

/// The saved supply for the slab, as the Node app screens it.
pub async fn read(legacy: &Legacy, asked: &Asked<'_>) -> Result<Supply, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Query<'a> {
        slab_id: &'a str,
        grade: &'a str,
        from: &'a str,
        to: &'a str,
        seller: &'a str,
        offset: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        key: Option<&'a str>,
    }
    let query = Query {
        slab_id: asked.id,
        grade: asked.grade,
        from: &asked.window.from,
        to: &asked.window.to,
        seller: asked.seller,
        offset: asked.offset,
        key: asked.source,
    };
    legacy.read_with("/api/slab-supply", &query).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listing_age_reads_as_the_react_grid_wrote_it() {
        let row = |age: Option<f64>| -> Row {
            serde_json::from_value(serde_json::json!({
                "key": "k", "status": "equivalent", "reasons": [], "deliveredAsk": null,
                "listingAgeDays": age,
                "listing": { "title": null, "providerId": "1", "sourceUrl": null, "price": null,
                    "priceKind": "ask", "shipping": null }
            }))
            .unwrap()
        };
        assert_eq!(row(None).age(), "Unknown");
        assert_eq!(row(Some(0.4)).age(), "<1 day");
        assert_eq!(row(Some(3.9)).age(), "3 days");
        assert_eq!(money(None), "Unknown");
        assert_eq!(
            money(Some(&Money {
                amount: 5.0,
                currency: None
            })),
            "Unknown currency 5.00"
        );
    }
}
