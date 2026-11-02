//! Confirming an ambiguous publication item live (`PATCH /api/inventory-batches/{batch}/publications`,
//! operation `confirm-ambiguous-item`): the operator saw the SKU's quantity go live in the Seller
//! Portal, so the item is published with when and the evidence, its receipt lots activate for the
//! seller, and a publication whose items all have their outcome is published. The same
//! confirmation again is answered as the first was; another for a published item is refused.
//!
//! Node read the publication, then saved the outcome and recovered publications each on its own;
//! here the caller holds them in one transaction. Evidence is compared as JSON values (key order
//! aside), as Node's `canonicalEvidence` compared it.
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgConnection;

use super::store::{self, ItemOutcome, Outcome};
use crate::{
    api::{js_number, js_string, js_trim},
    features::{
        inventory_economics::ledger::fingerprint::js_numbers, pricing::resolver::release_ms,
    },
    node_pg,
};

/// An ambiguous item confirmed live.
#[derive(Clone, Debug, PartialEq)]
pub struct Confirmation {
    pub publication_id: i64,
    pub item_id: i64,
    pub quantity: f64,
    pub seller: String,
    pub confirmed_at: DateTime<Utc>,
    pub evidence: Value,
}

/// Why a confirmation was not saved, each Node's answer.
#[derive(Debug, PartialEq)]
pub enum NotConfirmed {
    /// Not a confirmation it would read (its 400).
    Invalid,
    /// No such item, or not this batch's, seller's, quantity's or an ambiguous or published one
    /// (its 409).
    Mismatched,
    /// Confirmed before the publication went out or a lot was received, or with no lots (409).
    TooEarly,
    /// A published item confirmed at another time or with other evidence (409).
    Conflicting,
    /// Anything else (its 500, `String(error)`).
    Failed(String),
}

impl From<sqlx::Error> for NotConfirmed {
    fn from(error: sqlx::Error) -> Self {
        NotConfirmed::Failed(node_pg::thrown(error))
    }
}

impl NotConfirmed {
    /// Node's message.
    pub fn message(&self) -> &str {
        match self {
            NotConfirmed::Invalid => "A valid ambiguous confirmation is required",
            NotConfirmed::Mismatched => {
                "Confirmation does not match the ambiguous publication item"
            }
            NotConfirmed::TooEarly => {
                "Confirmation time precedes the publication or receipt evidence"
            }
            NotConfirmed::Conflicting => "Confirmation conflicts with saved publication evidence",
            NotConfirmed::Failed(why) => why,
        }
    }
}

/// JavaScript's `Number(value)` of a JSON value; NaN for none.
fn number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_number(text).unwrap_or(f64::NAN),
        Some(list @ Value::Array(_)) => js_number(&js_string(list)).unwrap_or(f64::NAN),
    }
}

/// A whole number from 1 up to the largest JavaScript counts exactly (`Number.isSafeInteger`).
fn id(value: f64) -> Option<i64> {
    (value.fract() == 0.0 && value > 0.0 && value <= 9_007_199_254_740_991.0)
        .then_some(value as i64)
}

/// The body read as Node read it at `now`, or why not.
pub fn read(body: &Value, now: DateTime<Utc>) -> Result<Confirmation, NotConfirmed> {
    let publication_id = id(number(body.get("publicationId")));
    let item_id = id(number(body.get("itemId")));
    let quantity = number(body.get("confirmedQuantity"));
    let seller = body
        .get("sellerKey")
        .and_then(Value::as_str)
        .map_or("", js_trim);
    let confirmed_at = body
        .get("confirmedAt")
        .and_then(Value::as_str)
        .and_then(release_ms)
        .and_then(|ms| DateTime::from_timestamp_millis(ms as i64));
    let evidence = body
        .get("evidence")
        .filter(|e| e.as_object().is_some_and(|fields| !fields.is_empty()));
    match (publication_id, item_id, confirmed_at, evidence) {
        (Some(publication_id), Some(item_id), Some(confirmed_at), Some(evidence))
            if body.get("operation").and_then(Value::as_str) == Some("confirm-ambiguous-item")
                && quantity.is_finite()
                && quantity.fract() == 0.0
                && quantity > 0.0
                && !seller.is_empty()
                && confirmed_at <= now =>
        {
            Ok(Confirmation {
                publication_id,
                item_id,
                quantity,
                seller: seller.to_owned(),
                confirmed_at,
                evidence: evidence.clone(),
            })
        }
        _ => Err(NotConfirmed::Invalid),
    }
}

/// One of the item's receipt lots: when it went live and on what evidence, and when it was received.
#[derive(sqlx::FromRow)]
struct ReceiptLink {
    live_at: Option<DateTime<Utc>>,
    evidence: Option<Value>,
    intake_at: Option<DateTime<Utc>>,
}

/// A time as Node read it from Postgres: to the millisecond.
fn ms(at: DateTime<Utc>) -> i64 {
    at.timestamp_millis()
}

/// Confirms the item for `batch` on `conn`, which the caller holds in a transaction: the
/// publication's id, to answer it with.
pub async fn confirm(
    conn: &mut PgConnection,
    batch: i32,
    confirmation: &Confirmation,
) -> Result<i64, NotConfirmed> {
    type Found = (
        i32,
        String,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<String>,
        Option<i32>,
    );
    let found: Option<Found> = sqlx::query_as(
        "SELECT publication.batch_number, publication.source_type, publication.seller_key,
           publication.publishing_at, item.status, item.quantity_delta
         FROM inventory_publications publication
         LEFT JOIN inventory_publication_items item
           ON item.publication_id = publication.id AND item.id = $2
         WHERE publication.id = $1",
    )
    .bind(confirmation.publication_id)
    .bind(confirmation.item_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((batch_number, source_type, seller, publishing_at, Some(status), Some(quantity))) =
        found
    else {
        return Err(NotConfirmed::Mismatched);
    };
    if batch_number != batch
        || source_type != "pending_inventory"
        || seller.as_deref() != Some(confirmation.seller.as_str())
        || !matches!(status.as_str(), "ambiguous" | "published")
        || f64::from(quantity) != confirmation.quantity
    {
        return Err(NotConfirmed::Mismatched);
    }
    let links: Vec<ReceiptLink> = sqlx::query_as(
        "SELECT link.live_at, link.confirmation_evidence AS evidence, receipt.intake_at
         FROM inventory_publication_receipt_links link
         JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
         WHERE link.publication_item_id = $1",
    )
    .bind(confirmation.item_id)
    .fetch_all(&mut *conn)
    .await?;
    let at = ms(confirmation.confirmed_at);
    let latest_intake = links.iter().filter_map(|link| link.intake_at.map(ms)).max();
    if links.is_empty()
        || latest_intake.is_some_and(|intake| at < intake)
        || publishing_at.is_some_and(|publishing| at < ms(publishing))
    {
        return Err(NotConfirmed::TooEarly);
    }
    let evidence = js_numbers(&confirmation.evidence);
    if status == "published" {
        let replayed = links.iter().all(|link| {
            link.live_at.map(ms) == Some(at)
                && link.evidence.as_ref().map(js_numbers).as_ref() == Some(&evidence)
        });
        if !replayed {
            return Err(NotConfirmed::Conflicting);
        }
    } else {
        let outcome = ItemOutcome {
            item_id: confirmation.item_id,
            outcome: Outcome::Published,
            error_code: None,
            error_message: None,
            confirmed: Some((confirmation.confirmed_at, evidence)),
        };
        store::save_outcomes(conn, confirmation.publication_id, &[outcome])
            .await
            .map_err(|error| match error {
                store::Error::Refused(why) => NotConfirmed::Failed(format!("Error: {why}")),
                store::Error::Database(error) => error.into(),
            })?;
    }
    store::recover_saved_outcomes(conn).await?;
    Ok(confirmation.publication_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        assert_eq!(number(Some(&Value::from(" 45719 "))), 45719.0);
        assert_eq!(number(Some(&serde_json::json!([5]))), 5.0);
        assert_eq!(number(Some(&Value::Null)), 0.0);
        assert!(number(None).is_nan());
        assert!(number(Some(&serde_json::json!({}))).is_nan());
        assert_eq!(id(9_007_199_254_740_992.0), None);
        assert_eq!(id(1.0), Some(1));
    }
}
