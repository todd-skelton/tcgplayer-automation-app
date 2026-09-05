export interface PricingCurvePoint {
  percentile: number;
  price: number;
  buyerIntervalDays?: number;
  storeWinShare?: number;
  estimatedMedianSellDays?: number;
  qualifyingSalesCount?: number;
  historyCapped?: boolean;
  listingsCount?: number;
  supplyStatus?: PricingSupplyStatus;
}

export const PRICING_MODEL_VERSION = "pooled-supply-v1" as const;

export type PricingSupplyStatus =
  | "observed"
  | "unavailable"
  | "disabled";

export type PricingPolicy =
  | { method: "percentile"; percentile: number }
  | { method: "target-horizon"; horizonDays: number }
  | {
      method: "profit-per-day";
      /** Fraction of capital earned per day when proceeds are redeployed. */
      dailyReturnHurdle: number;
      /** Overhead as a fraction of sale price. */
      relativeOverhead: number;
      /** Overhead in dollars per unit sold. */
      staticOverheadPerUnit: number;
    };

/** The stored choice with its settings resolved; percentile stays per product line. */
export type ActivePricingPolicy =
  { method: "percentile" } | Exclude<PricingPolicy, { method: "percentile" }>;

export type PricingConstraint =
  | "none"
  | "floor"
  | "current-price";

export type PricingDecisionBasis =
  | "modeled"
  | "market-reference"
  | "listing-reference"
  | "market-and-listing-reference"
  | "current-price"
  | "legacy-unknown";

export type PricingForecastStatus =
  | "interpolated"
  | "lower-bound"
  | "upper-bound"
  | "unavailable";

export interface PricingDecision {
  method: PricingPolicy["method"];
  selectedPrice: number;
  unconstrainedPrice?: number;
  equivalentPercentile?: number;
  configuredPercentile?: number;
  targetHorizonDays?: number;
  dailyReturnHurdle?: number;
  /** Net proceeds at the selected price do not clear per-unit overhead. */
  unprofitable?: boolean;
  buyerIntervalDays?: number;
  storeWinShare?: number;
  estimatedMedianSellDays?: number;
  qualifyingSalesCount?: number;
  historyCapped?: boolean;
  listingsCount?: number;
  supplyStatus?: PricingSupplyStatus;
  constraint: PricingConstraint;
  basis: PricingDecisionBasis;
  forecastStatus: PricingForecastStatus;
  planId?: string;
  planMatchStatus?: PortfolioMatchStatus;
}

export type PortfolioMatchStatus =
  | "matched"
  | "boundary"
  | "infeasible";

export interface PortfolioPricingPlan {
  id: string;
  modelVersion: typeof PRICING_MODEL_VERSION;
  createdAt: string;
  baselineValue: number;
  selectedOneCopyValue: number;
  valueDifference: number;
  valueTolerance: number;
  matchStatus: PortfolioMatchStatus;
  minimumReachableValue: number;
  maximumReachableValue: number;
  resolvedHorizonDays: number;
  inventorySnapshotId: string;
  modeledSkuCount: number;
  unavailableBaselineSkuCount: number;
  raisedCount: number;
  loweredCount: number;
  heldCount: number;
  sparseDecisionCount: number;
  cappedHistoryCount: number;
}
