//! Confirming an ambiguous publication item live, the Batch Pricer's publication repair: the
//! operator saw the SKU's quantity go live in Seller Portal, so the item is published with when and
//! the operator's note as its evidence, its receipt lots activate for the publication's seller, and
//! a publication whose items all have their outcome is published. The same confirmation again is
//! answered as the first was; another for a published item is refused.
//!
//! Only an item that adds received inventory can be confirmed: a staged delta of an Inventory
//! Manager batch, for a seller, with the receipt lots going live activates. The caller holds the
//! connection in a transaction, so the item, its lots and the publication change together. Times
//! are compared to the millisecond, the precision every saved time is compared at.
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    plan,
    store::{self, ItemOutcome, Outcome},
};

/// An ambiguous item the operator confirmed live.
#[derive(Clone, Debug, PartialEq)]
pub struct Confirmation {
    pub publication_id: i64,
    pub item_id: i64,
    /// The quantity Seller Portal showed going live.
    pub quantity: i32,
    pub confirmed_at: DateTime<Utc>,
    /// What the operator saw, and where.
    pub note: String,
}

impl Confirmation {
    /// The evidence saved with the item's lots.
    pub fn evidence(&self) -> Value {
        json!({ "source": "operator_confirmation", "note": self.note })
    }
}

/// Why a confirmation was not saved.
#[derive(Debug)]
pub enum NotConfirmed {
    /// No such item, or not an ambiguous or published one of this batch's received-inventory
    /// publication with receipt lots.
    Mismatched,
    /// The item adds another quantity than the one confirmed.
    OtherQuantity(i32),
    /// Confirmed before the publication was sent or a lot was received.
    TooEarly,
    /// A published item confirmed at another time or with other evidence.
    Conflicting,
    /// The outcome store refused it; the message says why.
    Refused(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for NotConfirmed {
    fn from(error: sqlx::Error) -> Self {
        NotConfirmed::Database(error)
    }
}

impl NotConfirmed {
    pub fn message(&self) -> String {
        match self {
            NotConfirmed::Mismatched => {
                "Confirmation does not match the ambiguous publication item".to_owned()
            }
            NotConfirmed::OtherQuantity(adds) => {
                format!(
                    "This item adds {adds}; enter the quantity Seller Portal showed going live."
                )
            }
            NotConfirmed::TooEarly => {
                "Confirmation time precedes the publication or receipt evidence".to_owned()
            }
            NotConfirmed::Conflicting => {
                "Confirmation conflicts with saved publication evidence".to_owned()
            }
            NotConfirmed::Refused(why) => why.clone(),
            NotConfirmed::Database(error) => error.to_string(),
        }
    }
}

/// What a confirmation did: the item's SKU, and where its publication stands now.
#[derive(Clone, Debug, PartialEq)]
pub struct Confirmed {
    pub publication_id: i64,
    pub sku: i32,
    pub publication_published: bool,
    /// The publication's items still without an outcome (planned or ambiguous).
    pub without_outcome: i64,
}

/// Whether a publication adds received inventory to a seller: the only kind whose items have
/// receipt lots for a confirmation to activate.
fn receives(source_type: &str, method: &str, seller: Option<&str>) -> bool {
    source_type == "pending_inventory" && method == plan::METHOD && seller.is_some()
}

fn ms(at: DateTime<Utc>) -> i64 {
    at.timestamp_millis()
}

/// The publication an item is confirmed in: its batch, what kind it is, and when it was sent to
/// Seller Portal (made, when it never was).
#[derive(sqlx::FromRow)]
struct Sent {
    batch_number: Option<i32>,
    source_type: String,
    method: String,
    seller_key: Option<String>,
    sent_at: DateTime<Utc>,
}

/// One of the item's receipt lots: when it went live and on what evidence, and when it was received.
#[derive(sqlx::FromRow)]
struct Lot {
    live_at: Option<DateTime<Utc>>,
    evidence: Option<Value>,
    intake_at: Option<DateTime<Utc>>,
}

/// Confirms the item for `batch` on `conn`, which the caller holds in a transaction. The
/// publication and then the item are locked, in the order saving an outcome locks them, so two
/// confirmations of one item are answered one after the other.
pub async fn confirm(
    conn: &mut PgConnection,
    batch: i32,
    confirmation: &Confirmation,
) -> Result<Confirmed, NotConfirmed> {
    let publication: Option<Sent> = sqlx::query_as(
        "SELECT batch_number, source_type, method, seller_key,
           COALESCE(publishing_at, created_at) AS sent_at
         FROM inventory_publications WHERE id = $1 FOR UPDATE",
    )
    .bind(confirmation.publication_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(publication) = publication else {
        return Err(NotConfirmed::Mismatched);
    };
    let seller = publication.seller_key.as_deref();
    if publication.batch_number != Some(batch)
        || !receives(&publication.source_type, &publication.method, seller)
    {
        return Err(NotConfirmed::Mismatched);
    }
    let item: Option<(String, i32, i32)> = sqlx::query_as(
        "SELECT status, sku, quantity_delta FROM inventory_publication_items
         WHERE id = $1 AND publication_id = $2 FOR UPDATE",
    )
    .bind(confirmation.item_id)
    .bind(confirmation.publication_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((status, sku, adds)) = item else {
        return Err(NotConfirmed::Mismatched);
    };
    if !matches!(status.as_str(), "ambiguous" | "published") || adds <= 0 {
        return Err(NotConfirmed::Mismatched);
    }
    if adds != confirmation.quantity {
        return Err(NotConfirmed::OtherQuantity(adds));
    }
    let lots: Vec<Lot> = sqlx::query_as(
        "SELECT link.live_at, link.confirmation_evidence AS evidence, receipt.intake_at
         FROM inventory_publication_receipt_links link
         JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
         WHERE link.publication_item_id = $1",
    )
    .bind(confirmation.item_id)
    .fetch_all(&mut *conn)
    .await?;
    if lots.is_empty() {
        return Err(NotConfirmed::Mismatched);
    }
    let at = ms(confirmation.confirmed_at);
    let latest_intake = lots.iter().filter_map(|lot| lot.intake_at.map(ms)).max();
    if at < ms(publication.sent_at) || latest_intake.is_some_and(|intake| at < intake) {
        return Err(NotConfirmed::TooEarly);
    }
    let evidence = confirmation.evidence();
    if status == "published" {
        let replayed = lots
            .iter()
            .all(|lot| lot.live_at.map(ms) == Some(at) && lot.evidence.as_ref() == Some(&evidence));
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
                store::Error::Refused(why) => NotConfirmed::Refused(why),
                store::Error::Database(error) => NotConfirmed::Database(error),
            })?;
    }
    store::recover_saved_outcomes(conn).await?;
    let (publication_status, without_outcome): (String, i64) = sqlx::query_as(
        "SELECT status, (SELECT COUNT(*) FROM inventory_publication_items
           WHERE publication_id = $1 AND status IN ('planned', 'ambiguous'))
         FROM inventory_publications WHERE id = $1",
    )
    .bind(confirmation.publication_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Confirmed {
        publication_id: confirmation.publication_id,
        sku,
        publication_published: publication_status == "published",
        without_outcome,
    })
}

/// An ambiguous item of a batch's publications, as the repair shows it.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Ambiguous {
    pub item_id: i64,
    pub publication_id: i64,
    pub sku: i32,
    pub product_name: String,
    pub set_name: String,
    pub condition: String,
    pub quantity_delta: i32,
    pub error_message: Option<String>,
    pub seller_key: Option<String>,
    source_type: String,
    method: String,
    /// When the publication was sent to Seller Portal, or made when it never was.
    pub sent_at: DateTime<Utc>,
    /// When its latest receipt lot was received, if any lot says.
    pub latest_intake_at: Option<DateTime<Utc>>,
    pub lots: i64,
}

impl Ambiguous {
    /// Whether it can be confirmed live: it adds received inventory, with lots to activate.
    pub fn confirmable(&self) -> bool {
        receives(&self.source_type, &self.method, self.seller_key.as_deref())
            && self.quantity_delta > 0
            && self.lots > 0
    }

    /// The earliest time it can have gone live: once it was sent and its lots received.
    pub fn earliest(&self) -> DateTime<Utc> {
        self.latest_intake_at
            .map_or(self.sent_at, |intake| intake.max(self.sent_at))
    }
}

/// The batch's ambiguous items, the newest publication's first.
pub async fn ambiguous(conn: &mut PgConnection, batch: i32) -> sqlx::Result<Vec<Ambiguous>> {
    sqlx::query_as(
        "SELECT item.id AS item_id, item.publication_id, item.sku, item.product_name, item.set_name,
           item.condition, item.quantity_delta, item.error_message, publication.seller_key,
           publication.source_type, publication.method,
           COALESCE(publication.publishing_at, publication.created_at) AS sent_at,
           lots.latest_intake_at, lots.count AS lots
         FROM inventory_publication_items item
         JOIN inventory_publications publication ON publication.id = item.publication_id
         CROSS JOIN LATERAL (SELECT COUNT(*) AS count, MAX(receipt.intake_at) AS latest_intake_at
           FROM inventory_publication_receipt_links link
           JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
           WHERE link.publication_item_id = item.id) lots
         WHERE publication.batch_number = $1 AND item.status = 'ambiguous'
         ORDER BY item.publication_id DESC, item.id",
    )
    .bind(batch)
    .fetch_all(&mut *conn)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    const SELLER: &str = "rust-test-publication-repair";

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    /// A received-inventory publication of a batch of its own, left ambiguous: its items, each
    /// adding a SKU's quantity from one receipt lot, and the SKUs.
    struct Left {
        batch: i32,
        publication: i64,
        items: Vec<i64>,
        skus: Vec<i32>,
    }

    /// The publication, sent at `sent`, with one item per `(quantity, received)` lot.
    async fn left_ambiguous(
        conn: &mut PgConnection,
        sent: DateTime<Utc>,
        lots: &[(i32, DateTime<Utc>)],
    ) -> Left {
        let batch: i32 = sqlx::query_scalar(
            "INSERT INTO inventory_batches (status, source_type, source_label)
             VALUES ('priced', 'pending_inventory', 'Inventory Manager') RETURNING batch_number",
        )
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        let key = format!("{SELLER}:{batch}");
        let publication: i64 = sqlx::query_scalar(
            "INSERT INTO inventory_publications (planning_key, batch_number, method, source_type,
               seller_key, status, publishing_at, error_code)
             VALUES ($1, $2, 'staged_delta', 'pending_inventory', $3, 'ambiguous', $4,
               'worker_lease_expired')
             RETURNING id",
        )
        .bind(&key)
        .bind(batch)
        .bind(SELLER)
        .bind(sent)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        let (mut items, mut skus) = (Vec::new(), Vec::new());
        for (n, (quantity, received)) in lots.iter().enumerate() {
            // SKUs no catalog has, so the FIFO replay queued is this test's alone.
            let sku = 2_100_000_000 + n as i32;
            let request = format!("{key}:{sku}");
            sqlx::query(
                "INSERT INTO inventory_pending_mutations (request_id, mutation_type, sku,
                   requested_quantity, product_line_id, set_id, product_id, quantity_delta,
                   resulting_quantity)
                 VALUES ($1, 'add', $2, $3, 1, 1, 1, $3, $3)",
            )
            .bind(&request)
            .bind(sku)
            .bind(quantity)
            .execute(&mut *conn)
            .await
            .unwrap();
            let receipt: i32 = sqlx::query_scalar(
                "INSERT INTO inventory_receipts (request_id, sku, original_quantity,
                   product_line_id, set_id, product_id, intake_at, market_provenance)
                 VALUES ($1, $2, $3, 1, 1, 1, $4, 'test') RETURNING receipt_id",
            )
            .bind(&request)
            .bind(sku)
            .bind(quantity)
            .bind(received)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
            let item: i64 = sqlx::query_scalar(
                "INSERT INTO inventory_publication_items (publication_id, candidate_key,
                   inventory_delta_key, batch_number, sku, product_id, product_line, set_name,
                   product_name, condition, desired_price, quantity_delta, priced_at, status,
                   error_code)
                 VALUES ($1, $2, $2, $3, $4, 1, 'Line', 'Set', 'Product', 'Near Mint', 1.5, $5,
                   NOW(), 'ambiguous', 'worker_lease_expired')
                 RETURNING id",
            )
            .bind(publication)
            .bind(&request)
            .bind(batch)
            .bind(sku)
            .bind(quantity)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO inventory_publication_receipt_links (publication_item_id, receipt_id,
                   planned_quantity, target_seller_key)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(item)
            .bind(receipt)
            .bind(quantity)
            .bind(SELLER)
            .execute(&mut *conn)
            .await
            .unwrap();
            items.push(item);
            skus.push(sku);
        }
        Left {
            batch,
            publication,
            items,
            skus,
        }
    }

    /// The item's status and when it was published, its lots' live time, evidence and seller, and
    /// whether its SKU's FIFO replay is queued.
    async fn saved(
        conn: &mut PgConnection,
        item: i64,
        sku: i32,
    ) -> (
        String,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
        Option<Value>,
        Option<String>,
        bool,
    ) {
        sqlx::query_as(
            "SELECT item.status, item.published_at, link.live_at, link.confirmation_evidence,
               receipt.seller_key,
               EXISTS (SELECT 1 FROM inventory_fifo_replay_queue queue
                 WHERE queue.seller_key = $3 AND queue.sku = $2)
             FROM inventory_publication_items item
             JOIN inventory_publication_receipt_links link ON link.publication_item_id = item.id
             JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
             WHERE item.id = $1",
        )
        .bind(item)
        .bind(sku)
        .bind(SELLER)
        .fetch_one(conn)
        .await
        .unwrap()
    }

    /// Each rule of a confirmation on the dev database, inside a transaction that is rolled back:
    /// one that does not match the item, says another quantity or a time before the publication
    /// was sent or its lot received is refused; one that matches publishes the item, activates its
    /// lot for the seller and queues its FIFO replay; the same again is answered as the first was,
    /// another time or note is refused; and the publication is published once its last item is.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn an_ambiguous_item_is_confirmed_live_once() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let sent = at("2026-01-02T10:00:00Z");
        let left = left_ambiguous(
            &mut tx,
            sent,
            &[
                (2, at("2026-01-01T09:00:00Z")),
                (1, at("2026-01-02T11:00:00Z")),
            ],
        )
        .await;
        let (first, second) = (left.items[0], left.items[1]);
        let confirmation = |item_id, quantity, confirmed_at: &str, note: &str| Confirmation {
            publication_id: left.publication,
            item_id,
            quantity,
            confirmed_at: at(confirmed_at),
            note: note.into(),
        };
        let seen = confirmation(first, 2, "2026-01-02T10:05:00Z", "Seller Portal, Live tab");

        let shown = ambiguous(&mut tx, left.batch).await.unwrap();
        assert_eq!(shown.len(), 2);
        assert!(shown.iter().all(Ambiguous::confirmable));
        assert_eq!(shown[0].earliest(), sent, "received before it was sent");
        assert_eq!(shown[1].earliest(), at("2026-01-02T11:00:00Z"));

        let refused = async |tx: &mut PgConnection, batch, confirmation: &Confirmation| {
            confirm(tx, batch, confirmation).await.unwrap_err()
        };
        assert!(matches!(
            refused(&mut tx, left.batch + 1, &seen).await,
            NotConfirmed::Mismatched
        ));
        let elsewhere = Confirmation {
            publication_id: -1,
            ..seen.clone()
        };
        assert!(matches!(
            refused(&mut tx, left.batch, &elsewhere).await,
            NotConfirmed::Mismatched
        ));
        let other_item = Confirmation {
            item_id: -1,
            ..seen.clone()
        };
        assert!(matches!(
            refused(&mut tx, left.batch, &other_item).await,
            NotConfirmed::Mismatched
        ));
        let three = confirmation(first, 3, "2026-01-02T10:05:00Z", "Seller Portal");
        assert!(matches!(
            refused(&mut tx, left.batch, &three).await,
            NotConfirmed::OtherQuantity(2)
        ));
        let before_sent = confirmation(first, 2, "2026-01-02T09:59:59Z", "Seller Portal");
        assert!(matches!(
            refused(&mut tx, left.batch, &before_sent).await,
            NotConfirmed::TooEarly
        ));
        let before_received = confirmation(second, 1, "2026-01-02T10:30:00Z", "Seller Portal");
        assert!(matches!(
            refused(&mut tx, left.batch, &before_received).await,
            NotConfirmed::TooEarly
        ));
        let (status, published_at, live_at, _, seller, queued) =
            saved(&mut tx, first, left.skus[0]).await;
        assert_eq!(
            (status.as_str(), published_at, live_at, seller, queued),
            ("ambiguous", None, None, None, false),
            "a refusal changes nothing"
        );

        let first_answer = confirm(&mut tx, left.batch, &seen).await.unwrap();
        assert_eq!(
            first_answer,
            Confirmed {
                publication_id: left.publication,
                sku: left.skus[0],
                publication_published: false,
                without_outcome: 1,
            }
        );
        let (status, published_at, live_at, evidence, seller, queued) =
            saved(&mut tx, first, left.skus[0]).await;
        assert_eq!(status, "published");
        assert_eq!(
            (published_at, live_at),
            (Some(seen.confirmed_at), Some(seen.confirmed_at))
        );
        assert_eq!(evidence, Some(seen.evidence()));
        assert_eq!(seller.as_deref(), Some(SELLER));
        assert!(
            queued,
            "the SKU's FIFO replay is queued from when it went live"
        );

        assert_eq!(
            confirm(&mut tx, left.batch, &seen).await.unwrap(),
            first_answer,
            "the same confirmation again is answered as the first was"
        );
        let later = Confirmation {
            confirmed_at: at("2026-01-02T10:06:00Z"),
            ..seen.clone()
        };
        assert!(matches!(
            refused(&mut tx, left.batch, &later).await,
            NotConfirmed::Conflicting
        ));
        let other_note = Confirmation {
            note: "A ticket".into(),
            ..seen.clone()
        };
        assert!(matches!(
            refused(&mut tx, left.batch, &other_note).await,
            NotConfirmed::Conflicting
        ));

        let last = confirmation(second, 1, "2026-01-02T11:30:00Z", "Seller Portal, Live tab");
        let answer = confirm(&mut tx, left.batch, &last).await.unwrap();
        assert!(answer.publication_published && answer.without_outcome == 0);
        let (status, published_at): (String, Option<DateTime<Utc>>) =
            sqlx::query_as("SELECT status, published_at FROM inventory_publications WHERE id = $1")
                .bind(left.publication)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(
            (status.as_str(), published_at),
            ("published", Some(last.confirmed_at)),
            "published when its last item went live"
        );
        assert!(ambiguous(&mut tx, left.batch).await.unwrap().is_empty());
        tx.rollback().await.unwrap();
    }
}
