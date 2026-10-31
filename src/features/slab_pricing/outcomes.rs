//! Seller outcomes: the reviewed sales, cancellations and relists recorded for an imported
//! listing (`readSellerOutcomes`), and which of them can be counted
//! (`reconcileSellerOutcomes`). Manually reviewed only; they change neither inventory nor
//! prices. Importing stays the Node app's (`/api/slab-outcomes`).
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;

use super::inventory::seller_account;
use crate::database::Database;

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
    pub seller: String,
    pub item_id: String,
    pub quantity: f64,
    pub kind: String,
    pub occurred_at: String,
    pub observed_at: String,
    pub price: Option<Price>,
    pub source: String,
    pub note: Option<String>,
    pub related_sale_id: Option<String>,
    pub next_item_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Price {
    pub amount: f64,
    pub currency: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Sales neither cancelled nor held.
    pub sales: u32,
    pub cancellations: u32,
    pub relists: u32,
    /// Event ids whose claims conflict or do not link: left out of usable sales.
    pub unresolved: Vec<String>,
    pub cancelled_sale_ids: Vec<String>,
    /// Sales a cancellation that could not be checked names: not counted until reviewed.
    pub held_sale_ids: Vec<String>,
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

fn time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// What makes two claims of one event the same claim.
type Signature<'a> = (
    &'a str,
    &'a str,
    &'a str,
    &'a str,
    Option<&'a str>,
    Option<&'a str>,
    u64,
    Option<(u64, &'a str)>,
    &'a str,
);

fn signature(o: &Observation) -> Signature<'_> {
    (
        &o.seller,
        &o.item_id,
        &o.occurred_at,
        &o.kind,
        o.next_item_id.as_deref(),
        o.related_sale_id.as_deref(),
        o.quantity.to_bits(),
        o.price
            .as_ref()
            .map(|p| (p.amount.to_bits(), p.currency.as_str())),
        &o.source,
    )
}

/// A claim that cannot be counted as it stands.
fn unusable(
    row: &Observation,
    copies: &[Observation],
    seller: &str,
    item_id: &str,
    as_of: DateTime<Utc>,
) -> bool {
    let (Some(occurred), Some(observed)) = (time(&row.occurred_at), time(&row.observed_at)) else {
        return true;
    };
    let three_letters = |c: &str| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase());
    row.id.is_empty()
        || row.seller != seller
        || row.item_id != item_id
        || copies.iter().any(|c| signature(c) != signature(row))
        || !matches!(row.kind.as_str(), "sale" | "cancellation" | "relist")
        || !matches!(row.source.as_str(), "ebay-seller" | "reviewed-manual")
        || observed > as_of
        || occurred > observed
        || row.quantity != 1.0
        || row.price.as_ref().is_some_and(|p| {
            !p.amount.is_finite() || p.amount <= 0.0 || !three_letters(&p.currency)
        })
        || (row.source == "reviewed-manual"
            && row.note.as_deref().is_none_or(|n| n.trim().is_empty()))
        || (row.kind == "relist"
            && row
                .next_item_id
                .as_deref()
                .is_none_or(|n| n.is_empty() || n == row.item_id))
}

/// `reconcileSellerOutcomes` for one listing: the claims of each event agree and link, or the
/// event is unresolved; a cancellation that cannot be checked holds the sale it names.
fn reconcile(
    observations: &[Observation],
    seller: &str,
    item_id: &str,
    as_of: DateTime<Utc>,
) -> Summary {
    let mut order: Vec<&str> = Vec::new();
    let mut events: HashMap<&str, Vec<Observation>> = HashMap::new();
    for row in observations {
        if time(&row.observed_at).is_some_and(|at| at > as_of) {
            continue;
        }
        let copies = events.entry(&row.id).or_default();
        if copies.is_empty() {
            order.push(&row.id);
        }
        copies.push(row.clone());
    }
    let mut known: Vec<Observation> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    let mut held: Vec<String> = Vec::new();
    let hold = |held: &mut Vec<String>, id: &str| {
        if !held.iter().any(|h| h == id) {
            held.push(id.to_owned());
        }
    };
    for id in order {
        let copies = &events[id];
        let row = copies
            .iter()
            .min_by(|a, b| a.observed_at.cmp(&b.observed_at))
            .expect("an event has a claim");
        if unusable(row, copies, seller, item_id, as_of) {
            unresolved.push(id.to_owned());
            for copy in copies {
                if copy.kind == "cancellation"
                    && let Some(sale) = copy.related_sale_id.as_deref().filter(|s| !s.is_empty())
                {
                    hold(&mut held, sale);
                }
            }
            continue;
        }
        known.push(row.clone());
    }
    let sales: HashMap<&str, &Observation> = known
        .iter()
        .filter(|r| r.kind == "sale")
        .map(|r| (r.id.as_str(), r))
        .collect();
    let mut cancelled: Vec<String> = Vec::new();
    for event in known.iter().filter(|r| r.kind == "cancellation") {
        let Some(related) = event.related_sale_id.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        let sale = sales.get(related);
        let links = sale.is_some_and(|sale| {
            sale.item_id == event.item_id && time(&sale.occurred_at) <= time(&event.occurred_at)
        });
        if links {
            if !cancelled.iter().any(|c| c == related) {
                cancelled.push(related.to_owned());
            }
        } else {
            unresolved.push(event.id.clone());
            if let Some(sale) = sale {
                hold(&mut held, &sale.id);
            }
        }
    }
    let excluded: HashSet<&String> = cancelled.iter().chain(&held).collect();
    let count = |kind: &str| known.iter().filter(|r| r.kind == kind).count() as u32;
    Summary {
        sales: known
            .iter()
            .filter(|r| r.kind == "sale" && !excluded.contains(&r.id))
            .count() as u32,
        cancellations: count("cancellation"),
        relists: count("relist"),
        unresolved,
        cancelled_sale_ids: cancelled,
        held_sale_ids: held,
    }
}

/// `readSellerOutcomes`: every claim, up to `as_of`, of the events recorded for one of the
/// seller's listings, and what they add up to.
async fn review(
    conn: &mut sqlx::PgConnection,
    seller: &str,
    item_id: &str,
    as_of: DateTime<Utc>,
) -> Result<Review, String> {
    let seller = seller_account(seller)?;
    let listing = (9..=15).contains(&item_id.len()) && item_id.bytes().all(|b| b.is_ascii_digit());
    if !listing {
        return Err("Choose one listing item ID and a valid observation time.".to_owned());
    }
    // Every claim for these event ids, so an incorrect-item correction cannot hide a conflict.
    let rows: Vec<(Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT payload, observed_at FROM slab_seller_outcomes WHERE seller = $1 AND observed_at <= $3
        AND event_id IN (SELECT event_id FROM slab_seller_outcomes WHERE seller = $1 AND item_id = $2 AND observed_at <= $3)
        ORDER BY observed_at, event_id, content_hash LIMIT 251",
    )
    .bind(&seller)
    .bind(item_id)
    .bind(as_of)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if rows.len() > 250 {
        return Err("This listing has more than 250 outcome observations and needs a separate audit before evaluation.".to_owned());
    }
    let observations = rows
        .into_iter()
        .map(|(mut payload, observed_at)| {
            payload["observedAt"] = observed_at
                .to_rfc3339_opts(SecondsFormat::Millis, true)
                .into();
            serde_json::from_value::<Observation>(payload)
                .map_err(|e| format!("A seller outcome could not be read: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let summary = reconcile(&observations, &seller, item_id, as_of);
    Ok(Review {
        item_id: item_id.to_owned(),
        observations,
        summary,
    })
}

/// The outcomes recorded for one of the seller's listings, as of now.
pub async fn read(db: &Database, seller: &str, item_id: &str) -> Result<Review, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    review(&mut conn, seller, item_id, Utc::now()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases in `.port-logs/seller-outcomes-cases.json` on the claims
    /// `seller-outcomes-seed.sql` saves, in a transaction rolled back, against Node's
    /// `readSellerOutcomes` (`.port-logs/seller-outcomes-node.ts`).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's reads in .port-logs"]
    async fn outcomes_read_as_node_reads_them() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            seller: String,
            item_id: String,
            as_of: String,
        }
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Case> =
            serde_json::from_str(&read_log("seller-outcomes-cases.json")).unwrap();
        let node: Vec<Value> =
            serde_json::from_str(&read_log("seller-outcomes.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("seller-outcomes-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(node) {
            let shown = format!("{} {} as of {}", case.seller, case.item_id, case.as_of);
            let as_of = time(&case.as_of).unwrap();
            match review(&mut tx, &case.seller, &case.item_id, as_of).await {
                Err(error) => assert_eq!(Some(error.as_str()), theirs["error"].as_str(), "{shown}"),
                Ok(ours) => {
                    assert_eq!(ours.item_id, theirs["itemId"], "{shown}");
                    let summary: Summary =
                        serde_json::from_value(theirs["summary"].clone()).unwrap();
                    assert_eq!(ours.summary, summary, "{shown}");
                    let observed = theirs["observations"].as_array().unwrap();
                    let ids = |o: &Value| {
                        (
                            o["id"].as_str().unwrap().to_owned(),
                            o["observedAt"].as_str().unwrap().to_owned(),
                        )
                    };
                    let ours: Vec<(String, String)> = ours
                        .observations
                        .iter()
                        .map(|o| (o.id.clone(), o.observed_at.clone()))
                        .collect();
                    assert_eq!(
                        ours,
                        observed.iter().map(ids).collect::<Vec<_>>(),
                        "{shown}"
                    );
                }
            }
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn an_observation_reads_as_one_line() {
        let row: Observation = serde_json::from_value(serde_json::json!({
            "id": "e1", "seller": "pokebash", "itemId": "123456789", "quantity": 1, "kind": "sale", "occurredAt": "2026-09-01T12:00:00Z",
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
