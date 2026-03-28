import type {
  ProcessingProgress,
  ProcessingSummary,
  TcgPlayerListing,
} from "~/core/types/pricing";
import type { ServerPricingConfig } from "~/features/pricing/types/config";

export type InventoryBatchStatus =
  | "pending"
  | "queued"
  | "pricing"
  | "priced"
  | "failed";
export type InventoryBatchPricingMode = "full" | "errors";
export type InventoryBatchResultStatus = "successful" | "manual_review";
export type InventoryBatchResultsScope = "successful" | "manual-review";
export type InventoryBatchItemsScope = "all" | "errors";
export type InventoryBatchPricingJobStatus =
  | "queued"
  | "pricing"
  | "completed"
  | "failed";

export interface InventoryBatchPricingJob {
  id: number;
  batchNumber: number;
  mode: InventoryBatchPricingMode;
  status: InventoryBatchPricingJobStatus;
  config: ServerPricingConfig;
  progress: ProcessingProgress | null;
  summary: ProcessingSummary | null;
  errorMessage: string | null;
  attemptCount: number;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

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
  latestJob: InventoryBatchPricingJob | null;
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

export interface InventoryBatchWithJob extends InventoryBatch {}
