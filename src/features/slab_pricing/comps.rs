//! Reviewing the saved comps of one evidence revision: each sale screened against the identity
//! researched, with the operator's decision on it. Screening and saving decisions stay the Node
//! app's (`/api/slab-comp-review`, read-only, and `/api/slab-comp-decisions`); fetching a sale's
//! details or an eBay source's next page queues a provider call for its worker.
use serde::{Deserialize, Serialize};

use super::url::Choice;
use crate::legacy::Legacy;

/// A page of a revision's sales, screened, and what can be done with them.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub revision_id: String,
    /// `alt-sales`, `ebay-sales` or `alt-sale-detail`.
    pub kind: String,
    /// The identity's revision the sales were screened against: a decision saved over a newer
    /// one is refused.
    pub identity_revision: i64,
    /// Decisions can be saved: the owned grade of a confirmed identity is researched.
    pub can_review: bool,
    pub coverage: Option<Coverage>,
    /// An eBay response of active listings instead of sold evidence.
    pub active_listings: bool,
    /// The eBay source has a next page to fetch.
    pub next_source_page: bool,
    pub page: Page,
    pub rows: Vec<Row>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub source_count: u32,
    pub reason: Option<String>,
    pub limit_per_grade: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub offset: u32,
    pub total: u32,
    pub next_offset: Option<u32>,
}

/// One sale, how it screened (`accepted`, `needs-review` or `rejected`) and why, and the
/// decision saved on it.
#[derive(Clone, Debug, Deserialize)]
pub struct Row {
    pub sale: Sale,
    pub status: String,
    pub reasons: Vec<String>,
    pub decision: Option<Decision>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sale {
    pub provider: String,
    pub provider_id: String,
    pub source_url: Option<String>,
    pub date: Option<String>,
    pub format: Option<String>,
    pub title: Option<String>,
    pub grading: Grading,
    pub price: Option<Money>,
    pub shipping: Option<Money>,
    pub quantity: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Grading {
    pub grader: String,
    pub encoding: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Money {
    pub amount: f64,
    pub currency: String,
}

/// `accept` or `exclude`, why, and the item price verified from the sale, if any.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub decision: String,
    pub note: String,
    pub item_price: Option<Money>,
}

impl Sale {
    /// Its title, or its provider's id when it has none.
    pub fn name(&self) -> &str {
        self.title.as_deref().unwrap_or(&self.provider_id)
    }

    /// `PSA 9` or `PSA MINT 9`: the grader and the label it printed, else its encoding.
    pub fn grade(&self) -> String {
        let shown = self
            .grading
            .label
            .as_deref()
            .unwrap_or(&self.grading.encoding);
        format!("{} {shown}", self.grading.grader)
    }

    /// A link to the sale, when it is an https address.
    pub fn link(&self) -> Option<&str> {
        self.source_url
            .as_deref()
            .filter(|u| u.starts_with("https://"))
    }
}

impl Review {
    /// The row at `index` in the whole revision, when it is on this page.
    pub fn row(&self, index: u32) -> Option<&Row> {
        let at = index.checked_sub(self.page.offset)?;
        self.rows.get(at as usize)
    }

    /// `51–100 of 120`, or how many when there is one page.
    pub fn range(&self) -> String {
        let shown = self.rows.len() as u32;
        let first = self.page.offset + u32::from(shown > 0);
        format!(
            "{first}–{} of {}",
            self.page.offset + shown,
            self.page.total
        )
    }

    /// What the revision covers, as the React review summed it up.
    pub fn summary(&self) -> String {
        let Some(c) = &self.coverage else {
            return "Saved sale detail".into();
        };
        let reason = c
            .reason
            .as_deref()
            .map(|r| format!(" · {}", super::identity::words(r)))
            .unwrap_or_default();
        let limit = c
            .limit_per_grade
            .map(|n| format!(" · Up to {n} sales per grade"))
            .unwrap_or_default();
        format!("{} source observations{reason}{limit}", c.source_count)
    }
}

/// `USD 12.30`, or "Unknown".
pub fn money(value: Option<&Money>) -> String {
    value.map_or_else(
        || "Unknown".into(),
        |m| format!("{} {:.2}", m.currency, m.amount),
    )
}

#[derive(Serialize)]
struct Asked<'a> {
    id: &'a str,
    grade: &'a str,
    from: &'a str,
    to: &'a str,
    revision: &'a str,
    offset: u32,
}

/// The page of `revision` the choice shows, screened against the slab `id` at its grade.
pub async fn read(
    legacy: &Legacy,
    id: &str,
    revision: &str,
    choice: &Choice,
) -> Result<Review, String> {
    let window = choice.window();
    let asked = Asked {
        id,
        grade: choice.grade(),
        from: &window.from,
        to: &window.to,
        revision,
        offset: choice.comps_from.unwrap_or(0),
    };
    legacy.read_with("/api/slab-comp-review", &asked).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review(offset: u32, rows: usize, total: u32) -> Review {
        let row = serde_json::json!({
            "sale": { "provider": "alt", "providerId": "p", "sourceUrl": "http://x", "date": null,
                "format": null, "title": null, "grading": { "grader": "PSA", "encoding": "9", "label": null },
                "price": null, "shipping": null, "quantity": null },
            "status": "accepted", "reasons": [], "decision": null
        });
        serde_json::from_value(serde_json::json!({
            "revisionId": "r", "kind": "alt-sales", "identityRevision": 1, "canReview": true,
            "coverage": { "sourceCount": 4, "reason": "capped-per-grade", "limitPerGrade": 16 },
            "activeListings": false, "nextSourcePage": false,
            "page": { "offset": offset, "total": total, "nextOffset": null },
            "rows": vec![row; rows]
        }))
        .unwrap()
    }

    #[test]
    fn a_row_is_found_by_its_place_in_the_revision() {
        let page = review(50, 2, 52);
        assert!(page.row(49).is_none());
        assert!(page.row(50).is_some());
        assert!(page.row(51).is_some());
        assert!(page.row(52).is_none());
        assert_eq!(page.range(), "51–52 of 52");
        assert_eq!(review(0, 0, 0).range(), "0–0 of 0");
    }

    #[test]
    fn a_sale_reads_as_the_react_review_wrote_it() {
        let page = review(0, 1, 1);
        let sale = &page.rows[0].sale;
        assert_eq!(sale.name(), "p");
        assert_eq!(sale.grade(), "PSA 9");
        assert_eq!(sale.link(), None, "only https links");
        assert_eq!(
            page.summary(),
            "4 source observations · capped per grade · Up to 16 sales per grade"
        );
        assert_eq!(money(None), "Unknown");
    }
}
