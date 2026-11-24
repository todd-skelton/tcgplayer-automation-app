//! A SKU taken out of a batch it was added to by mistake: one its pricing left for manual review
//! whose card was never in hand. Its item and result leave the batch, and what was received of it
//! for the batch is reversed as never received: each receipt adjusted to nothing as a correction,
//! recorded under one request ([`request_id`]), and no longer linked to the batch, so it is
//! neither pending again nor counted in the batch's cost. The SKU's pending count is left as it
//! is.
//!
//! A SKU in hand is refused: one a publication planned or sent from the batch, or one with a
//! receipt that is a seller's, owned by a purchase or costed in one.
use chrono::{DateTime, Utc};
use sqlx::PgConnection;

use super::{super::save, pricing};

/// What a removal reversed: the units received for the SKU that the batch held.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Removed {
    pub units: i32,
}

/// Why a SKU was not removed.
#[derive(Debug)]
pub enum NotRemoved {
    /// The batch is queued or pricing.
    Pricing,
    /// The SKU is gone from the batch, or no longer needs review.
    NotForReview,
    /// A publication planned or sent the SKU from the batch.
    Published,
    /// A receipt of the SKU is a seller's, owned by a purchase or costed in one.
    InHand,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for NotRemoved {
    fn from(e: sqlx::Error) -> Self {
        NotRemoved::Database(e)
    }
}

impl NotRemoved {
    pub fn message(&self, batch: i32, sku: i32) -> String {
        match self {
            NotRemoved::Pricing => {
                format!("Batch {batch} is pricing. Remove SKU {sku} once its pricing ends.")
            }
            NotRemoved::NotForReview => {
                format!("SKU {sku} in batch {batch} no longer needs review.")
            }
            NotRemoved::Published => format!(
                "SKU {sku} in batch {batch} was planned for publication, so it stays in the batch."
            ),
            NotRemoved::InHand => format!(
                "SKU {sku} in batch {batch} was received into a seller's inventory or a purchase, so it stays in the batch."
            ),
            NotRemoved::Database(e) => e.to_string(),
        }
    }
}

/// The request a removal's receipt corrections are recorded under: one per SKU and batch, so the
/// same removal is never recorded twice.
pub fn request_id(batch: i32, sku: i32) -> String {
    format!("batch-{batch}:sku-{sku}:removed")
}

#[derive(sqlx::FromRow)]
struct Linked {
    receipt_id: i32,
    product_line_id: i32,
    set_id: i32,
    product_id: i32,
    /// What is left of the receipt after its adjustments.
    quantity: i32,
    in_hand: bool,
}

/// Takes `sku` out of `batch` and reverses what was received of it for the batch, then refreshes
/// the batch's counts and summary, all on `conn` (the caller's transaction), under the lock every
/// change to pending receipts takes.
pub async fn remove(
    conn: &mut PgConnection,
    batch: i32,
    sku: i32,
    now: DateTime<Utc>,
) -> Result<Removed, NotRemoved> {
    sqlx::query("SELECT pg_advisory_xact_lock(55, 0)")
        .execute(&mut *conn)
        .await?;
    match pricing(conn, batch).await? {
        None => return Err(NotRemoved::NotForReview),
        Some(true) => return Err(NotRemoved::Pricing),
        Some(false) => {}
    }
    let reviewed: Option<i32> = sqlx::query_scalar(
        "SELECT sku FROM inventory_batch_results
         WHERE batch_number = $1 AND sku = $2 AND result_status <> 'successful'
         FOR UPDATE",
    )
    .bind(batch)
    .bind(sku)
    .fetch_optional(&mut *conn)
    .await?;
    if reviewed.is_none() {
        return Err(NotRemoved::NotForReview);
    }
    let published: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM inventory_publication_items
           WHERE batch_number = $1 AND sku = $2)",
    )
    .bind(batch)
    .bind(sku)
    .fetch_one(&mut *conn)
    .await?;
    if published {
        return Err(NotRemoved::Published);
    }
    let linked: Vec<Linked> = sqlx::query_as(
        "SELECT receipt.receipt_id, receipt.product_line_id, receipt.set_id, receipt.product_id,
           (receipt.original_quantity + COALESCE((SELECT SUM(adjustment.quantity_delta)
             FROM inventory_receipt_adjustments adjustment
             WHERE adjustment.receipt_id = receipt.receipt_id), 0))::int AS quantity,
           (receipt.seller_key IS NOT NULL
             OR EXISTS (SELECT 1 FROM inventory_purchase_receipt_ownership ownership
               WHERE ownership.receipt_id = receipt.receipt_id)
             OR EXISTS (SELECT 1 FROM inventory_purchase_cost_allocations allocation
               WHERE allocation.receipt_id = receipt.receipt_id)
             OR EXISTS (SELECT 1 FROM inventory_publication_receipt_links published
               WHERE published.receipt_id = receipt.receipt_id)) AS in_hand
         FROM inventory_receipt_batch_links link
         JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
         WHERE link.batch_number = $1 AND receipt.sku = $2
         ORDER BY receipt.receipt_id
         FOR UPDATE OF link",
    )
    .bind(batch)
    .bind(sku)
    .fetch_all(&mut *conn)
    .await?;
    if linked.iter().any(|l| l.in_hand) {
        return Err(NotRemoved::InHand);
    }
    let units = reverse(conn, batch, sku, &linked).await?;
    for table in ["inventory_batch_results", "inventory_batch_items"] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE batch_number = $1 AND sku = $2"
        ))
        .bind(batch)
        .bind(sku)
        .execute(&mut *conn)
        .await?;
    }
    save::refresh_counts(conn, batch, now).await?;
    Ok(Removed { units })
}

/// Adjusts each of the SKU's receipts linked to `batch` to nothing, as corrections under the
/// removal's request, and unlinks them; answers the units reversed. Nothing is recorded when the
/// batch holds no receipt of the SKU.
async fn reverse(
    conn: &mut PgConnection,
    batch: i32,
    sku: i32,
    linked: &[Linked],
) -> sqlx::Result<i32> {
    let Some(first) = linked.first() else {
        return Ok(0);
    };
    let (ids, deltas): (Vec<i32>, Vec<i32>) = linked
        .iter()
        .filter(|l| l.quantity > 0)
        .map(|l| (l.receipt_id, -l.quantity))
        .unzip();
    let units = -deltas.iter().sum::<i32>();
    let request = request_id(batch, sku);
    sqlx::query(
        "INSERT INTO inventory_pending_mutations (request_id, mutation_type, sku, requested_quantity,
           product_line_id, set_id, product_id, quantity_delta, resulting_quantity)
         VALUES ($1, 'remove', $2, $3, $4, $5, $6, 0,
           COALESCE((SELECT quantity FROM pending_inventory WHERE sku = $2), 0))",
    )
    .bind(&request)
    .bind(sku)
    .bind(units)
    .bind(first.product_line_id)
    .bind(first.set_id)
    .bind(first.product_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO inventory_receipt_adjustments (receipt_id, mutation_request_id, quantity_delta, reason)
         SELECT receipt, $2, delta, 'correction'
         FROM UNNEST($1::int[], $3::int[]) WITH ORDINALITY AS a(receipt, delta, n)
         ORDER BY n",
    )
    .bind(&ids)
    .bind(&request)
    .bind(&deltas)
    .execute(&mut *conn)
    .await?;
    let receipts: Vec<i32> = linked.iter().map(|l| l.receipt_id).collect();
    sqlx::query(
        "DELETE FROM inventory_receipt_batch_links
         WHERE batch_number = $1 AND receipt_id = ANY($2::int[])",
    )
    .bind(batch)
    .bind(&receipts)
    .execute(&mut *conn)
    .await?;
    Ok(units)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::database::Database;

    #[test]
    fn a_removal_is_recorded_once_per_sku_and_batch() {
        assert_eq!(request_id(8652, 7103132), "batch-8652:sku-7103132:removed");
    }

    /// The SKU's receipt, of `quantity`, received for `batch` and linked to it.
    async fn received(
        conn: &mut PgConnection,
        batch: i32,
        sku: i32,
        quantity: i32,
        seller: Option<&str>,
    ) -> i32 {
        let request = format!("test:{batch}:{sku}");
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
            "INSERT INTO inventory_receipts (request_id, sku, original_quantity, product_line_id,
               set_id, product_id, seller_key, intake_at, market_provenance)
             VALUES ($1, $2, $3, 1, 1, 1, $4, NOW(), 'test') RETURNING receipt_id",
        )
        .bind(&request)
        .bind(sku)
        .bind(quantity)
        .bind(seller)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO inventory_receipt_batch_links (receipt_id, batch_number, linked_quantity)
             VALUES ($1, $2, $3)",
        )
        .bind(receipt)
        .bind(batch)
        .bind(quantity)
        .execute(&mut *conn)
        .await
        .unwrap();
        receipt
    }

    /// On the dev database, in a transaction that is rolled back: a batch with one SKU priced and
    /// two left for review, each received for it. The one never in hand is removed: its item and
    /// result leave, the counts follow, and its receipt is adjusted to nothing and unlinked. A
    /// second removal is refused, as is a SKU whose receipt is a seller's, and one while the
    /// batch prices.
    #[tokio::test]
    #[ignore = "uses the dev database, in a transaction that is rolled back"]
    async fn a_sku_never_in_hand_leaves_the_batch_and_its_receipt_is_reversed() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let batch: i32 = sqlx::query_scalar(
            "INSERT INTO inventory_batches (status, source_type, source_label)
             VALUES ('priced', 'pending_inventory', 'Inventory Manager') RETURNING batch_number",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        // SKUs no catalog or pending count has, so what the test receives is its own.
        let (priced, mistaken, owned) = (2_100_000_001, 2_100_000_002, 2_100_000_003);
        let catalog = json!({ "Product Line": "Line", "Set Name": "Set", "Product": "Card",
                              "Sku Condition": "Near Mint" });
        sqlx::query(
            "INSERT INTO inventory_batch_items (batch_number, sku, total_quantity, add_to_quantity,
               product_line_id, set_id, product_id, original_row_json, created_at, updated_at)
             SELECT $1, sku, 0, 2, 1, 1, 1, $2, NOW(), NOW() FROM UNNEST($3::int[]) AS sku",
        )
        .bind(batch)
        .bind(&catalog)
        .bind([priced, mistaken, owned])
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO inventory_batch_pricing_jobs (batch_number, mode, status, config_json)
             VALUES ($1, 'full', 'completed', '{}'::jsonb)",
        )
        .bind(batch)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO inventory_batch_results (batch_number, sku, result_status, row_json,
               pricing_details_json, error_messages, priced_at)
             SELECT $1, sku, CASE WHEN sku = $3 THEN 'successful' ELSE 'manual_review' END, $2,
               '{}'::jsonb, ARRAY[]::text[], NOW()
             FROM UNNEST($4::int[]) AS sku",
        )
        .bind(batch)
        .bind(&catalog)
        .bind(priced)
        .bind([priced, mistaken, owned])
        .execute(&mut *tx)
        .await
        .unwrap();
        received(&mut tx, batch, priced, 2, None).await;
        let receipt = received(&mut tx, batch, mistaken, 2, None).await;
        received(&mut tx, batch, owned, 2, Some("test-seller")).await;
        save::refresh_counts(&mut tx, batch, Utc::now())
            .await
            .unwrap();

        let removed = remove(&mut tx, batch, mistaken, Utc::now()).await.unwrap();
        assert_eq!(removed, Removed { units: 2 });
        let skus: Vec<i32> = sqlx::query_scalar(
            "SELECT sku FROM inventory_batch_items WHERE batch_number = $1 ORDER BY sku",
        )
        .bind(batch)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert_eq!(skus, vec![priced, owned]);
        let counts: (i32, i32) = sqlx::query_as(
            "SELECT successful_count, manual_review_count FROM inventory_batches WHERE batch_number = $1",
        )
        .bind(batch)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(counts, (1, 1));
        let left: (i64, i64) = sqlx::query_as(
            "SELECT
               (SELECT COUNT(*) FROM inventory_receipt_batch_links WHERE receipt_id = $1),
               (SELECT r.original_quantity + COALESCE(SUM(a.quantity_delta), 0)
                FROM inventory_receipts r
                LEFT JOIN inventory_receipt_adjustments a ON a.receipt_id = r.receipt_id
                WHERE r.receipt_id = $1 GROUP BY r.receipt_id)",
        )
        .bind(receipt)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(left, (0, 0));
        let recorded: (String, i32, i32) = sqlx::query_as(
            "SELECT mutation_type, requested_quantity, quantity_delta
             FROM inventory_pending_mutations WHERE request_id = $1",
        )
        .bind(request_id(batch, mistaken))
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(recorded, ("remove".to_owned(), 2, 0));

        assert!(matches!(
            remove(&mut tx, batch, mistaken, Utc::now()).await,
            Err(NotRemoved::NotForReview)
        ));
        assert!(matches!(
            remove(&mut tx, batch, priced, Utc::now()).await,
            Err(NotRemoved::NotForReview)
        ));
        assert!(matches!(
            remove(&mut tx, batch, owned, Utc::now()).await,
            Err(NotRemoved::InHand)
        ));
        sqlx::query(
            "INSERT INTO inventory_batch_pricing_jobs (batch_number, mode, status, config_json)
             VALUES ($1, 'errors', 'queued', '{}'::jsonb)",
        )
        .bind(batch)
        .execute(&mut *tx)
        .await
        .unwrap();
        assert!(matches!(
            remove(&mut tx, batch, owned, Utc::now()).await,
            Err(NotRemoved::Pricing)
        ));
        tx.rollback().await.unwrap();
    }
}
