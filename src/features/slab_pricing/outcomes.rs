//! Seller outcomes: the reviewed sales, cancellations and relists recorded for an imported
//! listing. Manually reviewed only; they change neither inventory nor prices. Reading and
//! importing stay the Node app's (`/api/slab-outcomes`).
use serde::{Deserialize, Serialize};

use crate::legacy::Legacy;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub item_id: String,
    pub observations: Vec<Observation>,
    pub summary: Summary,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub item_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub observed_at: String,
    pub price: Option<Price>,
    pub source: String,
    pub note: Option<String>,
    pub related_sale_id: Option<String>,
    pub next_item_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Price {
    pub amount: f64,
    pub currency: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Summary {
    pub sales: u32,
    pub cancellations: u32,
    pub relists: u32,
    /// Event ids whose claims conflict or do not link: left out of usable sales.
    pub unresolved: Vec<String>,
}

/// What an import saved.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub inserted: u32,
    pub supplied: u32,
    pub item_ids: Vec<String>,
}

impl Observation {
    /// One line, as the React panel wrote an observation.
    pub fn line(&self) -> String {
        let words = |code: &str| code.replace(['-', '_'], " ");
        let price = self.price.as_ref().map_or_else(
            || "Unknown".to_owned(),
            |p| format!("{} {:.2}", p.currency, p.amount),
        );
        let mut line = format!(
            "{} · listing {} · {} · {} · {} · {} · first recorded {} · {}",
            self.id,
            self.item_id,
            words(&self.kind),
            self.occurred_at,
            price,
            words(&self.source),
            self.observed_at,
            self.note.as_deref().unwrap_or("")
        );
        if let Some(sale) = &self.related_sale_id {
            line.push_str(&format!(" · related sale {sale}"));
        }
        if let Some(next) = &self.next_item_id {
            line.push_str(&format!(" · relisted as {next}"));
        }
        line
    }
}

/// The outcomes recorded for one of the seller's listings.
pub async fn read(legacy: &Legacy, seller: &str, item_id: &str) -> Result<Review, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Query<'a> {
        seller: &'a str,
        item_id: &'a str,
    }
    legacy
        .read_with("/api/slab-outcomes", &Query { seller, item_id })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_observation_reads_as_one_line() {
        let row: Observation = serde_json::from_value(serde_json::json!({
            "id": "e1", "itemId": "123456789", "kind": "sale", "occurredAt": "2026-09-01T12:00:00Z",
            "observedAt": "2026-09-02T00:00:00.000Z", "price": { "amount": 40, "currency": "USD" },
            "source": "reviewed-manual", "note": "invoice", "relatedSaleId": null, "nextItemId": "987654321"
        }))
        .unwrap();
        assert_eq!(
            row.line(),
            "e1 · listing 123456789 · sale · 2026-09-01T12:00:00Z · USD 40.00 · reviewed manual · first recorded 2026-09-02T00:00:00.000Z · invoice · relisted as 987654321"
        );
    }
}
