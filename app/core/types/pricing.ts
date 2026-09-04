import type {
  ActivePricingPolicy,
  PortfolioPricingPlan,
  PricingDecision,
  PricingPolicy,
  PricingSupplyStatus,
} from "./pricingPolicy";

export interface TcgPlayerListing {
  "TCGplayer Id": string;
  "Product Line": string;
  "Set Name": string;
  Product: string;
  "Sku Variant": string;
  "Sku Condition": string;
  "Sale Count": string;
  "Lowest Sale Price": string;
  "Highest Sale Price": string;
  "TCG Market Price": string;
  "Total Quantity": string;
  "Add to Quantity": string;
  "TCG Marketplace Price": string;
  "Previous Price": string;
  "Suggested Price": string;
  "Percentile Used": string; // The percentile used for this SKU's pricing
  "Historical Sales Velocity (Days)": string; // Historical sales velocity
  "Estimated Time to Sell (Days)": string; // Market-adjusted time to sell
  "Sales Count for Historical Calculation": string; // Number of sales used for historical calculation
  "Listings Count for Estimated Calculation": string; // Number of listings used for estimated calculation
  Error: string;
  Warning: string;
}

export interface ProcessingProgress {
  current: number;
  total: number;
  status: string;
  processed: number;
  skipped: number;
  errors: number;
  warnings: number;
  // Hierarchical progress support
  phase?: string; // Current phase name (e.g., "Fetching Price Data")
  subProgress?: {
    // Sub-progress for current phase
    current: number;
    total: number;
    status: string;
  };
  phaseStartTime?: number; // Timestamp when phase started (for elapsed time)
}

export interface ProcessingSummary {
  totalRows: number;
  processedRows: number;
  skippedRows: number;
  errorRows: number;
  warningRows: number;
  successRate: number;
  processingTime: number;
  fileName: string;
  percentileUsed: number;
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
    percentiles: { [key: string]: number };
    quantityWithMarket: number;
  };
  medianDaysToSell: {
    historicalSalesVelocity: number; // Based on exposure-adjusted buyer arrival
    estimatedTimeToSell?: number; // Market-adjusted time (velocity + current competition) - optional
    percentiles: { [key: string]: number }; // Uses historical sales velocity by default
    marketAdjustedPercentiles?: { [key: string]: number }; // Market-adjusted percentiles if available
  };
  // Per-product-line breakdown when using product line pricing
  productLineBreakdown?: {
    [productLineName: string]: {
      count: number;
      percentileUsed: number;
      skipped: boolean;
      totalValue: number;
    };
  };
  shadowPortfolioPlan?: PortfolioPricingPlan;
}

export interface PricingPercentileDetail {
  percentile: number;
  suggestedPrice: number;
  historicalSalesVelocityDays?: number;
  estimatedTimeToSellDays?: number;
  salesCount?: number;
  historyCapped?: boolean;
  listingsCount?: number;
  storeWinShare?: number;
  supplyStatus?: PricingSupplyStatus;
}

/**
 * The buyer-choice sell-time forecast at the listed price, recorded beside
 * the curve's own forecast so realized sales can grade both.
 */
export interface BuyerChoiceForecast {
  medianSellDays: number;
  /** Name of the calibration that produced it. */
  calibration: string;
}

/** How sales from other conditions were scaled onto the listed condition. */
export interface ConditionNormalizationDetail {
  method:
    | "time-controlled-zipf"
    | "sibling-market-ratio"
    | "neutral-condition-fallback";
  observationCount: number;
  observedConditionCount: number;
  /** Absent when the multipliers came from sibling market prices. */
  conditionExponent?: number;
  conditionTimeConnected: boolean;
}

/** The listed condition's own sale rate over the last year. */
export interface ConditionSaleRate {
  /** Mean days between sales of this exact SKU, weighted toward the last quarter. */
  intervalDays: number;
  /** Sales of the SKU in the year. */
  transactions: number;
  /** Name of the estimator that produced it. */
  method: string;
}

/**
 * The sell-time forecast from the listed condition's own sale rate at the
 * listed price, recorded beside the curve's forecast so realized sales can
 * grade it.
 */
export interface ConditionRateForecast extends ConditionSaleRate {
  medianSellDays: number;
}

/**
 * What the SKU's own market says its price is: recent sales in the listed
 * condition and the asks of competing sellers in it. The price floor gives
 * way to either.
 */
export interface PriceEvidence {
  /** Lowest effective sale price of this exact SKU in the last 90 days. */
  ownConditionLowSalePrice?: number;
  /**
   * Second-cheapest delivered ask from another seller of this exact SKU,
   * known only when the store's own listing is excluded from the search.
   */
  secondCheapestAskPrice?: number;
}

export interface PersistedPricingDetails {
  schemaVersion: number;
  pricingModelVersion?: string;
  mode?: "full" | "errors" | "cached";
  pricedAt: string;
  marketDataAt?: string;
  productLineId?: number;
  percentileUsed?: number;
  suggestedPrice?: number;
  marketplacePrice?: number;
  previousPrice?: number;
  tcgMarketPrice?: number;
  lowestSalePrice?: number;
  highestSalePrice?: number;
  quantity?: number;
  addToQuantity?: number;
  historicalSalesVelocityDays?: number;
  estimatedTimeToSellDays?: number;
  salesCountForHistorical?: number;
  listingsCountForEstimated?: number;
  percentiles?: PricingPercentileDetail[];
  warnings?: string[];
  errors?: string[];
  featureFlags?: {
    supplyAnalysis?: boolean;
  };
  policy?: PricingPolicy;
  decision?: PricingDecision;
  shadowDecision?: PricingDecision;
  buyerChoiceForecast?: BuyerChoiceForecast;
  conditionRateForecast?: ConditionRateForecast;
  conditionNormalization?: ConditionNormalizationDetail;
  priceEvidence?: PriceEvidence;
}

export interface SuggestedPriceResult {
  error?: string;
  suggestedPrice: number | null;
  lowestListingPrice?: number;
  historicalSalesVelocityMs?: number; // Exposure-based buyer-arrival interval
  estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
  salesCount?: number; // Number of sales used for the selected percentile historical calculation
  listingsCount?: number; // Number of listings used for the selected percentile estimated calculation
  percentiles?: Array<{
    percentile: number;
    price: number;
    historicalSalesVelocityMs?: number; // Exposure-based buyer-arrival interval
    estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
    salesCount?: number; // Number of sales used for this percentile historical calculation
    historyCapped?: boolean;
    listingsCount?: number; // Number of listings used for this percentile estimated calculation
    storeWinShare?: number;
    supplyStatus?: PricingSupplyStatus;
  }>;
  conditionSaleRate?: ConditionSaleRate;
  conditionNormalization?: ConditionNormalizationDetail;
  priceEvidence?: PriceEvidence;
}

export interface SuggestedPriceResolverInput {
  tcgplayerId: string;
  percentile: number;
  additionalPercentiles?: number[];
  enableSupplyAnalysis?: boolean;
  supplyAnalysisConfig?: {
    includeUnverifiedSellers?: boolean;
    excludedSellerKey?: string;
  };
  productLineId?: number;
}

export type SuggestedPriceResolver = (
  input: SuggestedPriceResolverInput,
) => Promise<SuggestedPriceResult>;

export interface ProductLineSettings {
  percentile: number;
  skip: boolean;
  /** Daily return hurdle for this product line in place of the default. */
  dailyReturnHurdle?: number;
}

export interface PricingConfig {
  percentile: number;
  policy?: ActivePricingPolicy;
  minPriceMultiplier?: number;
  minPriceConstant?: number;
  halfLifeDays?: number; // For time decay in pricing algorithms
  onProgress?: (progress: ProcessingProgress) => void;
  onError?: (error: string) => void;
  isCancelled?: () => boolean;
  enableSupplyAnalysis?: boolean; // Enable market-adjusted time to sell calculations
  supplyAnalysisConfig?: {
    includeUnverifiedSellers?: boolean; // Include unverified sellers in analysis (default false)
    excludedSellerKey?: string;
  };
  // Per-product-line pricing configuration
  productLinePricingConfig?: {
    productLineSettings: Record<number, ProductLineSettings>;
    defaultPercentile: number;
  };
  suggestedPriceResolver?: SuggestedPriceResolver;
}

export type PricerSku = {
  sku: number;
  quantity?: number;
  addToQuantity?: number;
  currentPrice?: number;
  bypassProductLineSkips?: boolean;
  // Performance optimization metadata - required for optimal processing
  productLineId: number;
  setId: number;
  productId: number;
};

export type PricedSku = {
  sku: number;
  marketDataAt?: string;
  productLineId?: number;
  productLine?: string;
  setName?: string;
  productName?: string;
  variant?: string;
  condition?: string;
  lowestSalePrice?: number;
  highestSalePrice?: number;
  saleCount?: number;
  tcgMarketPrice?: number;
  quantity?: number;
  addToQuantity?: number;
  price?: number;
  previousPrice?: number;
  historicalSalesVelocityDays?: number; // Historical sales velocity in days
  estimatedTimeToSellDays?: number; // Market-adjusted time to sell in days
  salesCountForHistorical?: number; // Number of sales used for historical calculation
  listingsCountForEstimated?: number; // Number of listings used for estimated calculation
  suggestedPrice?: number;
  percentileUsed?: number; // The percentile used for this SKU's pricing
  percentiles?: PricingPercentileDetail[];
  pricingDecision?: PricingDecision;
  shadowPricingDecision?: PricingDecision;
  buyerChoiceForecast?: BuyerChoiceForecast;
  conditionRateForecast?: ConditionRateForecast;
  conditionNormalization?: ConditionNormalizationDetail;
  priceEvidence?: PriceEvidence;
  errors?: string[];
  warnings?: string[];
  pricingDetails?: PersistedPricingDetails;
};
