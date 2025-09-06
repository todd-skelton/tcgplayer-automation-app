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
    historicalSalesVelocity: number; // Based on historical sales intervals (sales velocity only)
    estimatedTimeToSell?: number; // Market-adjusted time (velocity + current competition) - optional
    percentiles: { [key: string]: number }; // Uses historical sales velocity by default
    marketAdjustedPercentiles?: { [key: string]: number }; // Market-adjusted percentiles if available
  };
}

export interface SuggestedPriceResult {
  error?: string;
  suggestedPrice: number | null;
  historicalSalesVelocityMs?: number; // Historical sales intervals (sales velocity only)
  estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
  salesCount?: number; // Number of sales used for the selected percentile historical calculation
  listingsCount?: number; // Number of listings used for the selected percentile estimated calculation
  percentiles?: Array<{
    percentile: number;
    price: number;
    historicalSalesVelocityMs?: number; // Historical sales intervals (sales velocity only)
    estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
    salesCount?: number; // Number of sales used for this percentile historical calculation
    listingsCount?: number; // Number of listings used for this percentile estimated calculation
  }>;
}

export interface PricingConfig {
  percentile: number;
  halfLifeDays?: number; // For time decay in pricing algorithms
  onProgress?: (progress: ProcessingProgress) => void;
  onError?: (error: string) => void;
  isCancelled?: () => boolean;
  enableSupplyAnalysis?: boolean; // Enable market-adjusted time to sell calculations
  supplyAnalysisConfig?: {
    maxListingsPerSku?: number; // Performance limit (default 200)
    includeUnverifiedSellers?: boolean; // Include unverified sellers in analysis (default false)
  };
}

export type PricerSku = {
  sku: number;
  quantity?: number;
  addToQuantity?: number;
  currentPrice?: number;
  // Performance optimization metadata - required for optimal processing
  productLineId: number;
  setId: number;
  productId: number;
};

export type PricedSku = {
  sku: number;
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
  errors?: string[];
  warnings?: string[];
};
