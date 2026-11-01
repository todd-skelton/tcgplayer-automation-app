//! `inventoryHistoryDiagnosticsRepository.get`: one read of every count, with the order history's
//! coverage.
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};

use crate::{
    database::Database,
    features::{
        inventory_economics::ledger::proceeds::iso, seller_order_history::coverage::coverage,
    },
};

/// Node's query, as it wrote it.
const COUNTS: &str = r#"WITH
        opening AS (
          SELECT run.id::text AS "openingRunId",run.cutoff_at AS "openingCutoffAt",
            run.applied_at AS "openingAppliedAt",run.validation_observation_id::text AS "validationObservationId",
            COALESCE(validation.unsupported_positive_item_count,0)::int AS "unsupportedPositiveItemCount",
            COALESCE(validation.unsupported_positive_quantity,0)::int AS "unsupportedPositiveQuantity"
          FROM inventory_opening_balance_runs run
          LEFT JOIN inventory_complete_observations validation ON validation.id=run.validation_observation_id
          WHERE run.seller_key=$1 AND run.status='applied' LIMIT 1
        ), queue AS (
          SELECT COUNT(*) FILTER (WHERE status='pending')::int AS "queuePending",
            COUNT(*) FILTER (WHERE status='processing')::int AS "queueProcessing",
            COUNT(*) FILTER (WHERE status='held')::int AS "queueHeld"
          FROM inventory_fifo_replay_queue WHERE seller_key=$1
        ), fifo AS (
          SELECT COUNT(*) FILTER (WHERE state='allocated')::int AS "linesAllocated",
            COUNT(*) FILTER (WHERE state='partial')::int AS "linesPartial",
            COUNT(*) FILTER (WHERE state='unmatched')::int AS "linesUnmatched",
            COUNT(*) FILTER (WHERE state='pending')::int AS "linesPending",
            COUNT(*) FILTER (WHERE state='held')::int AS "linesHeld",
            COUNT(*) FILTER (WHERE state='unsupported')::int AS "linesUnsupported",
            COUNT(*) FILTER (WHERE state='excluded_pre_cutoff')::int AS "linesExcludedPreCutoff",
            COUNT(*) FILTER (WHERE state='removed')::int AS "linesRemoved",
            COUNT(*) FILTER (WHERE replay.status='pending' AND line.state NOT IN ('excluded_pre_cutoff','removed','unsupported','canceled_unfulfilled'))::int AS "queuedLinesPending",
            COUNT(*) FILTER (WHERE replay.status='processing' AND line.state NOT IN ('excluded_pre_cutoff','removed','unsupported','canceled_unfulfilled'))::int AS "queuedLinesProcessing",
            COUNT(*) FILTER (WHERE replay.status='held' AND line.state NOT IN ('excluded_pre_cutoff','removed','unsupported','canceled_unfulfilled'))::int AS "queuedLinesHeld",
            COALESCE(SUM(line.ordered_quantity) FILTER (WHERE replay.status IS NULL AND line.state IN ('allocated','partial','unmatched')),0)::int AS "settledOrderedQuantity",
            COALESCE(SUM(line.matched_quantity) FILTER (WHERE replay.status IS NULL AND line.state IN ('allocated','partial','unmatched')),0)::int AS "settledMatchedQuantity",
            COALESCE(SUM(line.unmatched_quantity) FILTER (WHERE replay.status IS NULL AND line.state IN ('allocated','partial','unmatched')),0)::int AS "settledUnmatchedQuantity",
            COALESCE(SUM(line.ordered_quantity) FILTER (WHERE (replay.status IN ('pending','processing') AND line.state NOT IN ('excluded_pre_cutoff','removed','unsupported','canceled_unfulfilled')) OR (replay.status IS NULL AND line.state='pending')),0)::int AS "pendingOrProcessingQuantity",
            COALESCE(SUM(line.ordered_quantity) FILTER (WHERE (replay.status='held' AND line.state NOT IN ('excluded_pre_cutoff','removed','unsupported','canceled_unfulfilled')) OR (replay.status IS NULL AND line.state='held')),0)::int AS "heldQuantity",
            COALESCE(SUM(line.matched_quantity-line.price_known_quantity) FILTER (WHERE replay.status IS NULL AND line.state IN ('allocated','partial','unmatched')),0)::int AS "priceUnavailableQuantity",
            COALESCE(SUM(line.matched_quantity-line.date_known_quantity) FILTER (WHERE replay.status IS NULL AND line.state IN ('allocated','partial','unmatched')),0)::int AS "dateUnavailableQuantity"
          FROM inventory_fifo_lines line
          LEFT JOIN inventory_fifo_replay_queue replay ON replay.seller_key=line.seller_key AND replay.sku=line.sku
          WHERE line.seller_key=$1
        ), differences AS (
          SELECT COUNT(*)::int AS "observedDifferenceCount",
            COUNT(*) FILTER (WHERE status='unresolved')::int AS "unacknowledgedDifferenceCount",
            COUNT(*) FILTER (WHERE status='acknowledged')::int AS "acknowledgedDifferenceCount",
            COUNT(DISTINCT sku)::int AS "unresolvedDifferenceSkuCount",
            COALESCE(SUM(ABS(quantity_delta)),0)::int AS "unresolvedDifferenceQuantity"
          FROM inventory_observation_differences WHERE seller_key=$1
        ), receipts AS (
          SELECT COUNT(*)::int AS "receiptCount",COALESCE(SUM(original_quantity),0)::int AS "receivedQuantity",
            COALESCE(SUM(original_quantity) FILTER (WHERE market_value IS NULL),0)::int AS "missingMarketSnapshotQuantity",
            COALESCE(SUM(original_quantity) FILTER (WHERE intake_at IS NULL),0)::int AS "missingIntakeDateQuantity"
          FROM inventory_receipts WHERE seller_key=$1 AND receipt_kind='received'
        ), publications AS (
          SELECT COUNT(*) FILTER (WHERE status='planned')::int AS "publicationsPlanned",
            COUNT(*) FILTER (WHERE status IN ('staging','staged','publishing'))::int AS "publicationsActive",
            COUNT(*) FILTER (WHERE status='ambiguous')::int AS "publicationsAmbiguous",
            COUNT(*) FILTER (WHERE status='failed')::int AS "publicationsFailed",
            COUNT(*) FILTER (WHERE attempt_count>1)::int AS "publicationsRetried",
            MIN(created_at) FILTER (WHERE status='planned') AS "oldestPlannedAt",
            MAX(published_at) AS "lastPublishedAt"
          FROM inventory_publications WHERE seller_key=$1
        )
        SELECT opening.*,queue.*,fifo.*,differences.*,receipts.*,publications.*
        FROM queue CROSS JOIN fifo CROSS JOIN differences CROSS JOIN receipts CROSS JOIN publications
        LEFT JOIN opening ON true"#;

/// The diagnostics of `seller`'s inventory history, generated now.
pub async fn diagnostics(db: &Database, seller: &str) -> Result<Value, String> {
    let seller = seller.trim();
    if seller.is_empty() {
        return Err("Seller key is required.".into());
    }
    let failed = |e: sqlx::Error| e.to_string();
    let (order_coverage, row) = tokio::try_join!(
        async { coverage(db, seller).await.map_err(failed) },
        async {
            sqlx::query(COUNTS)
                .bind(seller)
                .fetch_optional(&db.0)
                .await
                .map_err(failed)
        },
    )?;
    let row = row.ok_or("Inventory history diagnostics could not be read.")?;
    let n = |name: &str| -> Result<i64, String> {
        let value: Option<i32> = row.try_get(name).map_err(failed)?;
        Ok(i64::from(value.unwrap_or(0)))
    };
    let at = |name: &str| -> Result<Value, String> {
        let value: Option<DateTime<Utc>> = row.try_get(name).map_err(failed)?;
        Ok(value.map_or(Value::Null, |at| iso(at).into()))
    };
    let text = |row: &PgRow, name: &str| -> Result<Option<String>, String> {
        row.try_get(name).map_err(failed)
    };
    let run = text(&row, "openingRunId")?;
    Ok(json!({
        "sellerKey": seller,
        "generatedAt": iso(Utc::now()),
        "orderCoverage": order_coverage,
        "openingBalance": {
            "status": if run.is_some() { "applied" } else { "not_applied" },
            "runId": run,
            "cutoffAt": at("openingCutoffAt")?,
            "appliedAt": at("openingAppliedAt")?,
            "validationObservationId": text(&row, "validationObservationId")?,
            "unsupportedPositiveItemCount": n("unsupportedPositiveItemCount")?,
            "unsupportedPositiveQuantity": n("unsupportedPositiveQuantity")?,
        },
        "fifo": {
            "queue": {
                "pending": n("queuePending")?,
                "processing": n("queueProcessing")?,
                "held": n("queueHeld")?,
            },
            "lines": {
                "allocated": n("linesAllocated")?,
                "partial": n("linesPartial")?,
                "unmatched": n("linesUnmatched")?,
                "pending": n("linesPending")?,
                "held": n("linesHeld")?,
                "unsupported": n("linesUnsupported")?,
                "excludedPreCutoff": n("linesExcludedPreCutoff")?,
                "removed": n("linesRemoved")?,
            },
            "queuedLineProjections": {
                "pending": n("queuedLinesPending")?,
                "processing": n("queuedLinesProcessing")?,
                "held": n("queuedLinesHeld")?,
            },
            "settledOrderedQuantity": n("settledOrderedQuantity")?,
            "settledMatchedQuantity": n("settledMatchedQuantity")?,
            "settledUnmatchedQuantity": n("settledUnmatchedQuantity")?,
            "pendingOrProcessingQuantity": n("pendingOrProcessingQuantity")?,
            "heldQuantity": n("heldQuantity")?,
            "priceUnavailableQuantity": n("priceUnavailableQuantity")?,
            "dateUnavailableQuantity": n("dateUnavailableQuantity")?,
        },
        "stockDifferences": {
            "observedCount": n("observedDifferenceCount")?,
            "unacknowledgedCount": n("unacknowledgedDifferenceCount")?,
            "acknowledgedCount": n("acknowledgedDifferenceCount")?,
            "affectedSkuCount": n("unresolvedDifferenceSkuCount")?,
            "absoluteQuantity": n("unresolvedDifferenceQuantity")?,
        },
        "receivedLots": {
            "receiptCount": n("receiptCount")?,
            "receivedQuantity": n("receivedQuantity")?,
            "missingMarketSnapshotQuantity": n("missingMarketSnapshotQuantity")?,
            "missingIntakeDateQuantity": n("missingIntakeDateQuantity")?,
        },
        "publications": {
            "planned": n("publicationsPlanned")?,
            "active": n("publicationsActive")?,
            "ambiguous": n("publicationsAmbiguous")?,
            "failed": n("publicationsFailed")?,
            "retried": n("publicationsRetried")?,
            "oldestPlannedAt": at("oldestPlannedAt")?,
            "lastPublishedAt": at("lastPublishedAt")?,
        },
    }))
}
