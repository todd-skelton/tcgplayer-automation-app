import type { PersistedPricingDetails } from "~/core/types/pricing";
import type { ForecastGrade } from "~/features/pricing/domain/forecastGrading";
import type { HorizonValueCurve } from "~/features/pricing/domain/horizonValueCurve";
import type {
  PricingPolicyConfig,
  ProfitPerDaySettings,
} from "~/features/pricing/types/config";

export const INVENTORY_STRATEGY_HORIZON_DAYS = [7, 14, 30, 60, 90, 180, 365];

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

export interface InventoryStrategyPolicyComparison {
  key: "current" | "percentile" | "target-horizon-shadow" | "profit-per-day";
  label: string;
  role: "current" | "active" | "benchmark" | "calibration";
  planState: "none" | "single" | "mixed";
  matchStatus:
    | "matched"
    | "boundary"
    | "infeasible"
    | "mixed"
    | null;
  oneCopyValue: number;
  physicalValue: number;
  modeledSkuCount: number;
  raisedCount: number;
  loweredCount: number;
  heldCount: number;
  estimatedTime: InventoryStrategyTimeDistribution | null;
}

export type InventoryStrategyConfidence =
  | "high"
  | "medium"
  | "low"
  | "unavailable";

export interface InventoryStrategyHorizonModel {
  minimumHorizonDays: number;
  maximumHorizonDays: number;
  curve: HorizonValueCurve | null;
  fitConfidence: InventoryStrategyConfidence;
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
  estimatedMarketValue: number;
  currentPolicyValue: number;
  mathematicalKneePercentile: number | null;
  estimatedPercentile: number | null;
  kneeRangeMinimum: number | null;
  kneeRangeMaximum: number | null;
  kneeConfidence: InventoryStrategyConfidence;
  modeledSkuCount: number;
  modeledUnitCount: number;
  oldestPricingAt: string | null;
  newestPricingAt: string | null;
  matrixPercentiles: number[];
  scenarios: InventoryStrategyScenario[];
  policyComparisons: InventoryStrategyPolicyComparison[];
  valueMatchedHorizonDays: number | null;
  horizonModel: InventoryStrategyHorizonModel | null;
}

export const FORECAST_GRADING_HORIZON_DAYS = [14, 21, 28];
export const DEFAULT_FORECAST_GRADING_HORIZON_DAYS = 21;

/** One continuous pricing result with the sell-time forecasts it recorded. */
export interface ForecastGradingRecord {
  sku: number;
  pricedAt: Date;
  quantity: number | null;
  basis: string | null;
  method: string | null;
  curveMedianSellDays: number | null;
  buyerChoiceMedianSellDays: number | null;
  buyerChoiceCalibration: string | null;
}

/** Both forecasts graded against realized sales over one horizon. */
export interface ForecastGradingReport {
  horizonDays: number;
  cohortSize: number;
  soldShare: number;
  baseRateBrier: number;
  /** Results whose buyer-choice forecast came from an earlier calibration. */
  otherCalibrationCount: number;
  curve: ForecastGrade;
  buyerChoice: ForecastGrade;
}

export interface InventoryStrategyDashboard {
  sellerKey: string;
  generatedAt: string;
  policy: PricingPolicyConfig;
  profitPerDay: ProfitPerDaySettings;
  overall: InventoryStrategyProductLine;
  productLines: InventoryStrategyProductLine[];
}
