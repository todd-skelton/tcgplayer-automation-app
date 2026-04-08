import type {
  PersistedPricingDetails,
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
export type InventoryBatchSourceType = "pending_inventory" | "seller" | "csv";
export type InventoryBatchPricingMode = "full" | "errors";
export type InventoryBatchResultStatus = "successful" | "manual_review";
export type InventoryBatchResultsScope = "successful" | "manual-review";
export type InventoryBatchItemsScope = "all" | "errors";
export type InventoryBatchPricingJobStatus =
  | "queued"
  | "pricing"
  | "completed"
  | "failed";

export interface InventoryBatchSummary {
  totalRows: number;
  processedRows: number;
  manualReviewRows: number;
  skippedRows: number;
  errorRows: number;
  warningRows: number;
  successRate: number;
  generatedAt: string;
  fileName: string;
  totalQuantity: number;
  totalAddQuantity: number;
  totals: {
    marketPrice: number;
    lowPrice: number;
    marketplacePrice: number;
    percentiles: { [key: string]: number };
  };
  totalsWithMarket: {
    marketPrice: number;
    lowPrice?: number;
    marketplacePrice?: number;
    percentiles: { [key: string]: number };
    quantityWithMarket: number;
  };
  medianDaysToSell: {
    historicalSalesVelocity: number;
    percentiles: { [key: string]: number };
    marketAdjustedPercentiles?: { [key: string]: number };
  };
  productLineBreakdown?: {
    [productLineName: string]: {
      count: number;
      percentilesUsed: number[];
      totalValue: number;
    };
  };
}

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
  sourceType: InventoryBatchSourceType;
  sourceLabel: string;
  createdAt: Date;
  updatedAt: Date;
  lastPricedAt: Date | null;
  summary: InventoryBatchSummary | null;
  successfulCount: number;
  manualReviewCount: number;
  itemCount: number;
  latestJob: InventoryBatchPricingJob | null;
}

export interface InventoryBatchItem {
  batchNumber: number;
  sku: number;
  totalQuantity: number;
  addToQuantity: number;
  currentPrice: number | null;
  productLineId: number;
  setId: number;
  productId: number;
  originalRow: TcgPlayerListing | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryBatchResult {
  batchNumber: number;
  sku: number;
  resultStatus: InventoryBatchResultStatus;
  row: TcgPlayerListing;
  pricingDetails: PersistedPricingDetails | null;
  errorMessages: string[];
  warningMessages: string[];
  pricedAt: Date;
}

export interface SaveInventoryBatchResultsParams {
  batchNumber: number;
  mode: InventoryBatchPricingMode;
  rows: Array<{
    sku: number;
    resultStatus: InventoryBatchResultStatus;
    row: TcgPlayerListing;
    pricingDetails: PersistedPricingDetails | null;
    errorMessages: string[];
    warningMessages: string[];
    pricedAt: Date;
  }>;
}

export interface InventoryBatchWithJob extends InventoryBatch {}

