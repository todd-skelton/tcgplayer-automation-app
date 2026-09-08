import type { InventoryHistoryDiagnostics } from "~/features/inventory-history/types/inventoryHistoryDiagnostics";
import { queryOne } from "../database.server";
import { sellerOrderHistoryRepository } from "./sellerOrderHistory.server";

type DiagnosticRow = {
  openingRunId: string | null;
  openingCutoffAt: Date | null;
  openingAppliedAt: Date | null;
  validationObservationId: string | null;
  unsupportedPositiveItemCount: number;
  unsupportedPositiveQuantity: number;
  queuePending: number;
  queueProcessing: number;
  queueHeld: number;
  linesAllocated: number;
  linesPending: number;
  linesHeld: number;
  linesUnsupported: number;
  orderedQuantity: number;
  matchedQuantity: number;
  unmatchedQuantity: number;
  priceUnavailableQuantity: number;
  dateUnavailableQuantity: number;
  unresolvedDifferenceCount: number;
  unresolvedDifferenceSkuCount: number;
  unresolvedDifferenceQuantity: number;
  receiptCount: number;
  receivedQuantity: number;
  missingMarketSnapshotQuantity: number;
  missingIntakeDateQuantity: number;
  publicationsPlanned: number;
  publicationsActive: number;
  publicationsAmbiguous: number;
  publicationsFailed: number;
  publicationsRetried: number;
  oldestPlannedAt: Date | null;
  lastPublishedAt: Date | null;
};

const count = (value: number | null | undefined) => value ?? 0;
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

export const inventoryHistoryDiagnosticsRepository = {
  async get(sellerKey: string): Promise<InventoryHistoryDiagnostics> {
    const seller = sellerKey.trim();
    if (!seller) throw new Error("Seller key is required.");
    const [orderCoverage, row] = await Promise.all([
      sellerOrderHistoryRepository.getCoverage(seller),
      queryOne<DiagnosticRow>(`WITH
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
            COUNT(*) FILTER (WHERE state='pending')::int AS "linesPending",
            COUNT(*) FILTER (WHERE state='held')::int AS "linesHeld",
            COUNT(*) FILTER (WHERE state='unsupported')::int AS "linesUnsupported",
            COALESCE(SUM(ordered_quantity),0)::int AS "orderedQuantity",
            COALESCE(SUM(matched_quantity),0)::int AS "matchedQuantity",
            COALESCE(SUM(unmatched_quantity),0)::int AS "unmatchedQuantity",
            COALESCE(SUM(matched_quantity-price_known_quantity),0)::int AS "priceUnavailableQuantity",
            COALESCE(SUM(matched_quantity-date_known_quantity),0)::int AS "dateUnavailableQuantity"
          FROM inventory_fifo_lines WHERE seller_key=$1
        ), differences AS (
          SELECT COUNT(*)::int AS "unresolvedDifferenceCount",COUNT(DISTINCT sku)::int AS "unresolvedDifferenceSkuCount",
            COALESCE(SUM(ABS(quantity_delta)),0)::int AS "unresolvedDifferenceQuantity"
          FROM inventory_observation_differences WHERE seller_key=$1 AND status='unresolved'
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
        LEFT JOIN opening ON true`, [seller]),
    ]);
    if (!row) throw new Error("Inventory history diagnostics could not be read.");
    return {
      sellerKey: seller,
      generatedAt: new Date().toISOString(),
      orderCoverage,
      openingBalance: {
        status: row.openingRunId ? "applied" : "not_applied",
        runId: row.openingRunId,
        cutoffAt: iso(row.openingCutoffAt),
        appliedAt: iso(row.openingAppliedAt),
        validationObservationId: row.validationObservationId,
        unsupportedPositiveItemCount: count(row.unsupportedPositiveItemCount),
        unsupportedPositiveQuantity: count(row.unsupportedPositiveQuantity),
      },
      fifo: {
        queue: { pending: count(row.queuePending), processing: count(row.queueProcessing), held: count(row.queueHeld) },
        lines: { allocated: count(row.linesAllocated), pending: count(row.linesPending), held: count(row.linesHeld), unsupported: count(row.linesUnsupported) },
        orderedQuantity: count(row.orderedQuantity), matchedQuantity: count(row.matchedQuantity),
        unmatchedQuantity: count(row.unmatchedQuantity), priceUnavailableQuantity: count(row.priceUnavailableQuantity),
        dateUnavailableQuantity: count(row.dateUnavailableQuantity),
      },
      stockDifferences: { unresolvedCount: count(row.unresolvedDifferenceCount), affectedSkuCount: count(row.unresolvedDifferenceSkuCount), absoluteQuantity: count(row.unresolvedDifferenceQuantity) },
      receivedLots: { receiptCount: count(row.receiptCount), receivedQuantity: count(row.receivedQuantity),
        missingMarketSnapshotQuantity: count(row.missingMarketSnapshotQuantity), missingIntakeDateQuantity: count(row.missingIntakeDateQuantity) },
      publications: { planned: count(row.publicationsPlanned), active: count(row.publicationsActive), ambiguous: count(row.publicationsAmbiguous),
        failed: count(row.publicationsFailed), retried: count(row.publicationsRetried), oldestPlannedAt: iso(row.oldestPlannedAt), lastPublishedAt: iso(row.lastPublishedAt) },
    };
  },
};
