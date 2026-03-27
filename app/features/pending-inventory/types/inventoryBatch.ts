import type { ProcessingSummary, TcgPlayerListing } from "~/core/types/pricing";

export type InventoryBatchStatus = "pending" | "priced";
export type InventoryBatchPricingMode = "full" | "errors";
export type InventoryBatchResultStatus = "successful" | "manual_review";
export type InventoryBatchResultsScope = "successful" | "manual-review";
export type InventoryBatchItemsScope = "all" | "errors";

export interface InventoryBatch {
  batchNumber: number;
  status: InventoryBatchStatus;
  createdAt: Date;
  updatedAt: Date;
  lastPricedAt: Date | null;
  summary: ProcessingSummary | null;
  successfulCount: number;
  manualReviewCount: number;
  itemCount: number;
}

export interface InventoryBatchItem {
  batchNumber: number;
  sku: number;
  quantity: number;
  productLineId: number;
  setId: number;
  productId: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryBatchResult {
  batchNumber: number;
  sku: number;
  resultStatus: InventoryBatchResultStatus;
  row: TcgPlayerListing;
  errorMessages: string[];
  warningMessages: string[];
  pricedAt: Date;
}

export interface SaveInventoryBatchResultsParams {
  batchNumber: number;
  mode: InventoryBatchPricingMode;
  summary: ProcessingSummary;
  rows: Array<{
    sku: number;
    resultStatus: InventoryBatchResultStatus;
    row: TcgPlayerListing;
    errorMessages: string[];
    warningMessages: string[];
    pricedAt: Date;
  }>;
}
