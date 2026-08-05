import type { TcgPlayerListing } from "~/core/types/pricing";

export interface ContinuousPricingSettings {
  enabled: boolean;
  sellerKey: string;
  minimumIntervalMinutes: number;
  inventoryRefreshMinutes: number;
  schedulerPollSeconds: number;
  batchSize: number;
}

export const DEFAULT_CONTINUOUS_PRICING_SETTINGS: ContinuousPricingSettings = {
  enabled: false,
  sellerKey: "",
  minimumIntervalMinutes: 24 * 60,
  inventoryRefreshMinutes: 60,
  schedulerPollSeconds: 30,
  batchSize: 100,
};

export interface ContinuousPricingInventoryItem {
  sellerKey: string;
  sku: number;
  productId: number;
  productLineId: number;
  setId: number;
  productLine: string;
  setName: string;
  productName: string;
  condition: string;
  variant: string;
  quantity: number;
  currentPrice: number | null;
  inStock: boolean;
  enabled: boolean;
  pauseReason: string | null;
  lastObservedAt: Date;
  lastPricedAt: Date | null;
  lastPublishedPrice: number | null;
  lastPublishedAt: Date | null;
  nextPriceAt: Date;
  lastBatchNumber: number | null;
  consecutivePricingFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertContinuousPricingInventoryItem {
  sellerKey: string;
  sku: number;
  productId: number;
  productLineId: number;
  setId: number;
  productLine: string;
  setName: string;
  productName: string;
  condition: string;
  variant: string;
  quantity: number;
  currentPrice: number | null;
  originalRow: TcgPlayerListing;
}

export interface ContinuousPricingStatus {
  settings: ContinuousPricingSettings;
  inventoryCount: number;
  enabledInStockCount: number;
  dueCount: number;
  oldestDueAt: Date | null;
  lastRefreshAt: Date | null;
  lastRefreshStatus: "refreshing" | "completed" | "failed" | null;
  lastRefreshError: string | null;
}
