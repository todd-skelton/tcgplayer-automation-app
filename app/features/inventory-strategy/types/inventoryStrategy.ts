import type { PersistedPricingDetails } from "~/core/types/pricing";

export const INVENTORY_STRATEGY_PERCENTILES = [
  10, 20, 30, 40, 50, 60, 70, 80, 90,
] as const;

export type InventoryStrategyPercentile = number;

export interface InventoryStrategySnapshotItem {
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
  marketPrice: number | null;
  pricingEligible: boolean;
  pricingDetails: PersistedPricingDetails | null;
  strategyPricedAt: Date | null;
}

export interface InventoryStrategyTimeDistribution {
  medianDays: number;
  p75Days: number;
  p90Days: number;
}

export interface InventoryStrategyScenario {
  percentile: InventoryStrategyPercentile;
  listedValue: number;
  deltaFromCurrentPolicy: number;
  deltaPercentFromCurrentPolicy: number | null;
  modeledSkuCount: number;
  modeledUnitCount: number;
  timeModeledUnitCount: number;
  estimatedTime: InventoryStrategyTimeDistribution | null;
}

export interface InventoryStrategyProductLine {
  key: string;
  productLineId: number | null;
  productLine: string;
  configuredPercentile: number | null;
  pricingEligible: boolean;
  skuCount: number;
  unitCount: number;
  currentListedValue: number;
  currentMarketValue: number;
  currentPolicyValue: number;
  modeledSkuCount: number;
  modeledUnitCount: number;
  oldestPricingAt: string | null;
  newestPricingAt: string | null;
  scenarios: InventoryStrategyScenario[];
}

export interface InventoryStrategyDashboard {
  sellerKey: string;
  generatedAt: string;
  overall: InventoryStrategyProductLine;
  productLines: InventoryStrategyProductLine[];
}
