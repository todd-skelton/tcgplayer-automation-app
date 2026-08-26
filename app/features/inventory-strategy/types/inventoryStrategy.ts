import type { PersistedPricingDetails } from "~/core/types/pricing";

export const INVENTORY_STRATEGY_MIN_PERCENTILE = 5;
export const INVENTORY_STRATEGY_MAX_PERCENTILE = 95;
export const INVENTORY_STRATEGY_PERCENTILES = Array.from(
  {
    length:
      (INVENTORY_STRATEGY_MAX_PERCENTILE - INVENTORY_STRATEGY_MIN_PERCENTILE) /
        5 +
      1,
  },
  (_, index) => INVENTORY_STRATEGY_MIN_PERCENTILE + index * 5,
);
export const INVENTORY_STRATEGY_PREVIEW_PERCENTILES = Array.from(
  {
    length:
      INVENTORY_STRATEGY_MAX_PERCENTILE - INVENTORY_STRATEGY_MIN_PERCENTILE + 1,
  },
  (_, index) => INVENTORY_STRATEGY_MIN_PERCENTILE + index,
);

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
  kneeScore: number | null;
  listedValue: number;
  deltaFromCurrentPolicy: number;
  deltaPercentFromCurrentPolicy: number | null;
  modeledSkuCount: number;
  modeledUnitCount: number;
  interpolatedSkuCount: number;
  interpolatedUnitCount: number;
  timeModeledUnitCount: number;
  estimatedTime: InventoryStrategyTimeDistribution | null;
}

export type InventoryStrategyKneeConfidence =
  | "high"
  | "medium"
  | "low"
  | "unavailable";

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
  mathematicalKneePercentile: number | null;
  estimatedPercentile: number | null;
  kneeRangeMinimum: number | null;
  kneeRangeMaximum: number | null;
  kneeConfidence: InventoryStrategyKneeConfidence;
  modeledSkuCount: number;
  modeledUnitCount: number;
  oldestPricingAt: string | null;
  newestPricingAt: string | null;
  matrixPercentiles: number[];
  scenarios: InventoryStrategyScenario[];
}

export interface InventoryStrategyDashboard {
  sellerKey: string;
  generatedAt: string;
  overall: InventoryStrategyProductLine;
  productLines: InventoryStrategyProductLine[];
}
