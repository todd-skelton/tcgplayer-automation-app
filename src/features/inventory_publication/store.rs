//! The publications the worker claims and the outcomes it saves, as the Node app's
//! `inventoryPublicationsRepository` writes them: the oldest planned publication claimed under a
//! lease, its status moved only along `ALLOWED_TRANSITIONS`, each item's outcome saved with the
//! receipt lots a received SKU makes live, and the publications a lost worker left behind put
//! right.
use std::fmt;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Connection, PgConnection};

use crate::features::inventory_fifo::queue;

/// Why a write was refused or failed.
#[derive(Debug)]
pub enum Error {
    /// Refused as Node refuses it; the message is Node's.
    Refused(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        Error::Database(error)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Refused(why) => f.write_str(why),
            Error::Database(error) => write!(f, "{error}"),
        }
    }
}

fn refused<T>(why: impl Into<String>) -> Result<T, Error> {
    Err(Error::Refused(why.into()))
}

/// Where a publication stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Planned,
    Staging,
    Staged,
    Publishing,
    Published,
    Ambiguous,
    Failed,
    RolledBack,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Planned => "planned",
            Status::Staging => "staging",
            Status::Staged => "staged",
            Status::Publishing => "publishing",
            Status::Published => "published",
            Status::Ambiguous => "ambiguous",
            Status::Failed => "failed",
            Status::RolledBack => "rolled_back",
        }
    }

    /// Whether a publication may move from this status to `next` (`ALLOWED_TRANSITIONS`).
    pub fn can_become(self, next: Status) -> bool {
        use Status::*;
        let allowed: &[Status] = match self {
            Planned => &[Staging, Publishing, Failed],
            Staging => &[Planned, Staged, Ambiguous, Failed, RolledBack],
            Staged => &[Publishing, Ambiguous, Failed, RolledBack],
            Publishing => &[Published, Ambiguous, Failed],
            Ambiguous => &[Published, Failed, RolledBack],
            Failed => &[RolledBack],
            Published | RolledBack => &[],
        };
        allowed.contains(&next)
    }
}

/// A publication as the worker reads it.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Publication {
    pub id: i64,
    pub batch_number: Option<i32>,
    pub method: String,
    pub source_type: String,
    pub seller_key: Option<String>,
    pub status: String,
    #[sqlx(skip)]
    pub items: Vec<Item>,
}

/// One SKU of a publication.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Item {
    pub id: i64,
    pub sku: i32,
    pub desired_price: f64,
    pub quantity_delta: i32,
    pub priced_at: DateTime<Utc>,
    pub status: String,
    pub published_at: Option<DateTime<Utc>>,
}

/// What became of an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Published,
    Ambiguous,
    Failed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Published => "published",
            Outcome::Ambiguous => "ambiguous",
            Outcome::Failed => "failed",
        }
    }
}

/// An item's outcome, and for one Seller Portal confirmed live, when and how.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemOutcome {
    pub item_id: i64,
    pub outcome: Outcome,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub confirmed: Option<(DateTime<Utc>, Value)>,
}

async fn with_items(
    conn: &mut PgConnection,
    publication: Option<Publication>,
) -> sqlx::Result<Option<Publication>> {
    let Some(mut publication) = publication else {
        return Ok(None);
    };
    publication.items = sqlx::query_as(
        "SELECT id, sku, desired_price::float8 AS desired_price, quantity_delta, priced_at, status,
                published_at
         FROM inventory_publication_items WHERE publication_id = $1 ORDER BY id",
    )
    .bind(publication.id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Some(publication))
}

/// Claims the oldest planned publication for `worker` for `lease_ms` (`claimNextPlanned`): a
/// staged one starts staging, a direct one publishing.
pub async fn claim_next(
    conn: &mut PgConnection,
    worker: &str,
    lease_ms: i64,
) -> Result<Option<Publication>, Error> {
    if worker.trim().is_empty() {
        return refused("workerId must not be empty.");
    }
    if lease_ms <= 0 {
        return refused("leaseMs must be a positive integer.");
    }
    let mut tx = conn.begin().await?;
    let claimed: Option<Publication> = sqlx::query_as(
        "WITH next_publication AS (
           SELECT id FROM inventory_publications WHERE status = 'planned'
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE inventory_publications publication
         SET status = CASE WHEN publication.method = 'direct_absolute' THEN 'publishing' ELSE 'staging' END,
             publishing_at = CASE WHEN publication.method = 'direct_absolute' THEN NOW() ELSE publishing_at END,
             claimed_by = $1,
             claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
             attempt_count = attempt_count + 1,
             updated_at = NOW()
         FROM next_publication
         WHERE publication.id = next_publication.id
         RETURNING publication.id, publication.batch_number, publication.method,
           publication.source_type, publication.seller_key, publication.status",
    )
    .bind(worker)
    .bind(lease_ms as f64)
    .fetch_optional(&mut *tx)
    .await?;
    let claimed = with_items(&mut tx, claimed).await?;
    tx.commit().await?;
    Ok(claimed)
}

/// Extends `worker`'s lease while the publication is in Seller Portal's hands.
pub async fn heartbeat(
    conn: &mut PgConnection,
    id: i64,
    worker: &str,
    lease_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE inventory_publications
         SET claim_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE id = $1 AND claimed_by = $2 AND status IN ('staging', 'publishing')",
    )
    .bind(id)
    .bind(worker)
    .bind(lease_ms as f64)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Records the staged upload Seller Portal opened for the publication `worker` is staging.
pub async fn record_upload(
    conn: &mut PgConnection,
    id: i64,
    worker: &str,
    upload_id: i64,
) -> Result<(), Error> {
    let upload = match i32::try_from(upload_id) {
        Ok(upload) if upload > 0 => upload,
        _ => return refused("stagedPricingUploadId must be a positive integer."),
    };
    let updated = sqlx::query(
        "UPDATE inventory_publications SET staged_pricing_upload_id = $3, updated_at = NOW()
         WHERE id = $1 AND claimed_by = $2 AND status = 'staging'
           AND (staged_pricing_upload_id IS NULL OR staged_pricing_upload_id = $3)",
    )
    .bind(id)
    .bind(worker)
    .bind(upload)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if updated != 1 {
        return refused(format!(
            "Inventory publication {id} could not record staged upload {upload_id}."
        ));
    }
    Ok(())
}

/// The worker that must hold the publication, and the error it ends with.
#[derive(Clone, Debug, Default)]
pub struct Moved<'a> {
    pub worker: Option<&'a str>,
    pub error_code: Option<&'a str>,
    pub error_message: Option<&'a str>,
}

/// Moves the publication from `expected` to `next` (`transitionStatus`), stamping when it
/// staged, published or ended; a publication that ended is no longer claimed. Answers it as it
/// now stands.
pub async fn transition(
    conn: &mut PgConnection,
    id: i64,
    expected: Status,
    next: Status,
    moved: Moved<'_>,
) -> Result<Publication, Error> {
    if !expected.can_become(next) {
        return refused(format!(
            "Inventory publication cannot transition from {} to {}.",
            expected.as_str(),
            next.as_str()
        ));
    }
    let updated: Option<Publication> = sqlx::query_as(
        "UPDATE inventory_publications
         SET status = $3, error_code = $5, error_message = $6,
             staged_at = CASE WHEN $3 = 'staged' THEN NOW() ELSE staged_at END,
             publishing_at = CASE WHEN $3 = 'publishing' THEN NOW() ELSE publishing_at END,
             published_at = CASE WHEN $3 = 'published' THEN NOW() ELSE published_at END,
             completed_at = CASE WHEN $3 IN ('published', 'failed', 'rolled_back') THEN NOW() ELSE completed_at END,
             claimed_by = CASE WHEN $3 IN ('staging', 'staged', 'publishing') THEN claimed_by ELSE NULL END,
             claim_expires_at = CASE WHEN $3 IN ('staging', 'staged', 'publishing') THEN claim_expires_at ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1 AND status = $2 AND ($4::text IS NULL OR claimed_by = $4)
           AND ($3 <> 'staged' OR staged_pricing_upload_id IS NOT NULL)
         RETURNING id, batch_number, method, source_type, seller_key, status",
    )
    .bind(id)
    .bind(expected.as_str())
    .bind(next.as_str())
    .bind(moved.worker)
    .bind(moved.error_code)
    .bind(moved.error_message)
    .fetch_optional(&mut *conn)
    .await?;
    match with_items(conn, updated).await? {
        Some(publication) => Ok(publication),
        None => refused(format!(
            "Inventory publication {id} did not transition from {} to {}.",
            expected.as_str(),
            next.as_str()
        )),
    }
}

/// Ends every item still planned as `outcome` with the error (`markPlannedItems`). Answers how
/// many.
pub async fn mark_planned(
    conn: &mut PgConnection,
    id: i64,
    outcome: Outcome,
    error_code: &str,
    error_message: &str,
) -> sqlx::Result<u64> {
    let marked = sqlx::query(
        "UPDATE inventory_publication_items
         SET status = $2, error_code = $3, error_message = $4, updated_at = NOW()
         WHERE publication_id = $1 AND status = 'planned'",
    )
    .bind(id)
    .bind(outcome.as_str())
    .bind(error_code)
    .bind(error_message)
    .execute(&mut *conn)
    .await?;
    Ok(marked.rows_affected())
}

/// Saves the items' outcomes in one transaction (`saveItemOutcomes`). An item moves only from
/// planned, or from ambiguous to published once confirmed; the same outcome again is no change.
/// A received SKU's staged delta published live activates its receipt lots for the seller, with
/// the confirmation, and queues the SKU's FIFO replay from when it went live.
pub async fn save_outcomes(
    conn: &mut PgConnection,
    id: i64,
    outcomes: &[ItemOutcome],
) -> Result<(), Error> {
    if outcomes.is_empty() {
        return Ok(());
    }
    let mut tx = conn.begin().await?;
    let publication: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT source_type, method, seller_key FROM inventory_publications WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((source_type, method, seller)) = publication else {
        return refused(format!("Inventory publication {id} not found."));
    };
    for outcome in outcomes {
        let item_id = outcome.item_id;
        let item: Option<(String, i32, i32, Option<DateTime<Utc>>)> = sqlx::query_as(
            "SELECT status, sku, quantity_delta, published_at FROM inventory_publication_items
             WHERE id = $1 AND publication_id = $2 FOR UPDATE",
        )
        .bind(item_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((status, sku, quantity_delta, published_at)) = item else {
            return refused(format!("Publication item {item_id} not found."));
        };
        let next = outcome.outcome.as_str();
        let correction = status == "ambiguous" && outcome.outcome == Outcome::Published;
        let repeated = status == next;
        if status != "planned" && !repeated && !correction {
            return refused(format!(
                "Publication item {item_id} cannot change from {status} to {next}."
            ));
        }
        let activates = source_type == "pending_inventory"
            && method == "staged_delta"
            && quantity_delta > 0
            && outcome.outcome == Outcome::Published;
        let confirmation = match (&seller, &outcome.confirmed) {
            (Some(seller), Some((at, evidence))) => Some((seller, *at, evidence)),
            _ => None,
        };
        if activates && confirmation.is_none() {
            return refused(format!(
                "Publication item {item_id} requires seller, confirmation time, and evidence before receipt activation."
            ));
        }
        let from: Vec<&str> = if correction {
            vec!["planned", "ambiguous", "published"]
        } else {
            vec!["planned", next]
        };
        sqlx::query(
            "UPDATE inventory_publication_items
             SET status = $3, error_code = $4, error_message = $5,
                 published_at = CASE WHEN $3 = 'published' THEN COALESCE(published_at, $6) ELSE published_at END,
                 updated_at = NOW()
             WHERE id = $1 AND publication_id = $2 AND status = ANY($7::text[])",
        )
        .bind(item_id)
        .bind(id)
        .bind(next)
        .bind(&outcome.error_code)
        .bind(&outcome.error_message)
        .bind(outcome.confirmed.as_ref().map_or_else(Utc::now, |(at, _)| *at))
        .bind(&from)
        .execute(&mut *tx)
        .await?;
        let (Some((seller, confirmed_at, evidence)), true) = (confirmation, activates) else {
            continue;
        };
        let (planned, links, activated, mismatched, conflicting): (i32, i32, i32, i32, i32) =
            sqlx::query_as(
                "SELECT COALESCE(SUM(link.planned_quantity), 0)::int,
                   COUNT(*)::int,
                   COUNT(*) FILTER (WHERE link.live_at IS NOT NULL)::int,
                   COUNT(*) FILTER (WHERE receipt.seller_key IS NOT NULL AND receipt.seller_key <> $2)::int,
                   COUNT(*) FILTER (WHERE link.live_at IS NOT NULL
                     AND (link.live_at <> $3 OR link.confirmation_evidence IS DISTINCT FROM $4::jsonb))::int
                 FROM inventory_publication_receipt_links link
                 JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
                 WHERE link.publication_item_id = $1 AND link.target_seller_key = $2",
            )
            .bind(item_id)
            .bind(seller)
            .bind(confirmed_at)
            .bind(evidence)
            .fetch_one(&mut *tx)
            .await?;
        if mismatched > 0 {
            return refused(format!(
                "Publication item {item_id} has receipts assigned to another seller."
            ));
        }
        if planned != quantity_delta {
            return refused(format!(
                "Publication item {item_id} cannot activate {quantity_delta} units from {planned} linked units."
            ));
        }
        if repeated && (activated != links || conflicting > 0 || published_at != Some(confirmed_at))
        {
            return refused(format!(
                "Publication item {item_id} already has different confirmation evidence."
            ));
        }
        sqlx::query(
            "UPDATE inventory_receipts receipt SET seller_key = $2
             FROM inventory_publication_receipt_links link
             WHERE link.publication_item_id = $1 AND link.receipt_id = receipt.receipt_id
               AND receipt.seller_key IS NULL",
        )
        .bind(item_id)
        .bind(seller)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE inventory_publication_receipt_links
             SET live_at = COALESCE(live_at, $2), activated_at = COALESCE(activated_at, NOW()),
                 confirmation_evidence = COALESCE(confirmation_evidence, $3::jsonb)
             WHERE publication_item_id = $1",
        )
        .bind(item_id)
        .bind(confirmed_at)
        .bind(evidence)
        .execute(&mut *tx)
        .await?;
        if !repeated {
            queue::enqueue(&mut tx, seller.trim(), sku, confirmed_at).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Publishes the ambiguous publications, and those a lost worker left publishing, whose items
/// all have their outcome and at least one was published (`recoverPublicationsWithSavedOutcomes`).
/// Answers how many.
pub async fn recover_saved_outcomes(conn: &mut PgConnection) -> sqlx::Result<usize> {
    let recovered: Vec<i64> = sqlx::query_scalar(
        "UPDATE inventory_publications publication
         SET status = 'published',
             published_at = COALESCE(publication.published_at,
               (SELECT MAX(item.published_at) FROM inventory_publication_items item
                WHERE item.publication_id = publication.id)),
             completed_at = COALESCE(publication.completed_at, NOW()),
             error_code = NULL, error_message = NULL, claimed_by = NULL, claim_expires_at = NULL,
             updated_at = NOW()
         WHERE (publication.status = 'ambiguous'
             OR (publication.status = 'publishing'
               AND (publication.claimed_by IS NULL OR publication.claim_expires_at IS NULL
                 OR publication.claim_expires_at < NOW())))
           AND EXISTS (SELECT 1 FROM inventory_publication_items item
             WHERE item.publication_id = publication.id AND item.status = 'published')
           AND NOT EXISTS (SELECT 1 FROM inventory_publication_items item
             WHERE item.publication_id = publication.id AND item.status IN ('planned', 'ambiguous'))
         RETURNING publication.id",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(recovered.len())
}

const LEASE_EXPIRED: &str = "Worker lease expired after Seller Portal state may have changed.";

/// Takes back the publications whose worker's lease ran out (`recoverExpiredClaims`): one that
/// never reached Seller Portal is planned again; one that may have changed it is ambiguous, with
/// its planned items. Answers how many.
pub async fn recover_expired_claims(conn: &mut PgConnection) -> sqlx::Result<usize> {
    let mut tx = conn.begin().await?;
    let recovered: Vec<i64> = sqlx::query_scalar(
        "UPDATE inventory_publications
         SET status = CASE WHEN status = 'publishing' THEN 'ambiguous'
               WHEN staged_pricing_upload_id IS NOT NULL THEN 'ambiguous' ELSE 'planned' END,
             error_code = CASE WHEN status = 'publishing' OR staged_pricing_upload_id IS NOT NULL
               THEN 'worker_lease_expired' ELSE error_code END,
             error_message = CASE WHEN status = 'publishing' OR staged_pricing_upload_id IS NOT NULL
               THEN $1 ELSE error_message END,
             claimed_by = NULL, claim_expires_at = NULL, updated_at = NOW()
         WHERE status IN ('staging', 'staged', 'publishing')
           AND claim_expires_at IS NOT NULL AND claim_expires_at < NOW()
         RETURNING id",
    )
    .bind(LEASE_EXPIRED)
    .fetch_all(&mut *tx)
    .await?;
    if !recovered.is_empty() {
        sqlx::query(
            "UPDATE inventory_publication_items item
             SET status = 'ambiguous', error_code = 'worker_lease_expired', error_message = $2,
                 updated_at = NOW()
             FROM inventory_publications publication
             WHERE item.publication_id = publication.id AND publication.id = ANY($1::bigint[])
               AND publication.status = 'ambiguous' AND item.status = 'planned'",
        )
        .bind(&recovered)
        .bind(LEASE_EXPIRED)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(recovered.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_publication_moves_only_as_node_allows() {
        use Status::*;
        let all = [
            Planned, Staging, Staged, Publishing, Published, Ambiguous, Failed, RolledBack,
        ];
        let allowed: Vec<(&str, &str)> = all
            .iter()
            .flat_map(|from| all.iter().map(move |to| (*from, *to)))
            .filter(|(from, to)| from.can_become(*to))
            .map(|(from, to)| (from.as_str(), to.as_str()))
            .collect();
        assert_eq!(
            allowed,
            [
                ("planned", "staging"),
                ("planned", "publishing"),
                ("planned", "failed"),
                ("staging", "planned"),
                ("staging", "staged"),
                ("staging", "ambiguous"),
                ("staging", "failed"),
                ("staging", "rolled_back"),
                ("staged", "publishing"),
                ("staged", "ambiguous"),
                ("staged", "failed"),
                ("staged", "rolled_back"),
                ("publishing", "published"),
                ("publishing", "ambiguous"),
                ("publishing", "failed"),
                ("ambiguous", "published"),
                ("ambiguous", "failed"),
                ("ambiguous", "rolled_back"),
                ("failed", "rolled_back"),
            ]
        );
    }
}
