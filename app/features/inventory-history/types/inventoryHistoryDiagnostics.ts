import type { SellerOrderCoverage } from "~/features/seller-order-history/types/sellerOrderHistory";

export interface InventoryHistoryDiagnostics {
  sellerKey: string;
  generatedAt: string;
  orderCoverage: SellerOrderCoverage;
  openingBalance: {
    status: "applied" | "not_applied";
    runId: string | null;
    cutoffAt: string | null;
    appliedAt: string | null;
    validationObservationId: string | null;
    unsupportedPositiveItemCount: number;
    unsupportedPositiveQuantity: number;
  };
  fifo: {
    queue: { pending: number; processing: number; held: number };
    lines: {
      allocated: number;
      partial: number;
      unmatched: number;
      pending: number;
      held: number;
      unsupported: number;
      excludedPreCutoff: number;
      removed: number;
    };
    queuedLineProjections: { pending: number; processing: number; held: number };
    settledOrderedQuantity: number;
    settledMatchedQuantity: number;
    settledUnmatchedQuantity: number;
    pendingOrProcessingQuantity: number;
    heldQuantity: number;
    priceUnavailableQuantity: number;
    dateUnavailableQuantity: number;
  };
  stockDifferences: {
    observedCount: number;
    unacknowledgedCount: number;
    acknowledgedCount: number;
    affectedSkuCount: number;
    absoluteQuantity: number;
  };
  receivedLots: {
    receiptCount: number;
    receivedQuantity: number;
    missingMarketSnapshotQuantity: number;
    missingIntakeDateQuantity: number;
  };
  publications: {
    planned: number;
    active: number;
    ambiguous: number;
    failed: number;
    retried: number;
    oldestPlannedAt: string | null;
    lastPublishedAt: string | null;
  };
}
