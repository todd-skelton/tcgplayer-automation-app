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
    lines: { allocated: number; pending: number; held: number; unsupported: number };
    orderedQuantity: number;
    matchedQuantity: number;
    unmatchedQuantity: number;
    priceUnavailableQuantity: number;
    dateUnavailableQuantity: number;
  };
  stockDifferences: {
    unresolvedCount: number;
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
