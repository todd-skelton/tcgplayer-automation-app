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
  "Expected Days to Sell": string;
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
  warnings?: number;
}

export interface ProcessingSummary {
  totalRows: number;
  processedRows: number;
  skippedRows: number;
  errorRows: number;
  warningRows?: number;
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
    demandOnlyDaysToSell: number; // Based on historical sales intervals (demand only)
    estimatedDaysToSell?: number; // Supply-adjusted time (supply + demand) - optional
    percentiles: { [key: string]: number }; // Uses demand-only by default
    supplyAdjustedPercentiles?: { [key: string]: number }; // Supply-adjusted percentiles if available
  };
}

export interface SuggestedPriceResult {
  error?: string;
  suggestedPrice: number | null;
  demandOnlyTimeToSellMs?: number; // Historical sales intervals (demand only)
  estimatedTimeToSellMs?: number; // Supply-adjusted time (supply + demand)
  percentiles?: Array<{
    percentile: number;
    price: number;
    demandOnlyTimeToSellMs?: number; // Historical sales intervals (demand only)
    estimatedTimeToSellMs?: number; // Supply-adjusted time (supply + demand)
  }>;
}

export interface PricingConfig {
  percentile: number;
  onProgress?: (progress: ProcessingProgress) => void;
  onError?: (error: string) => void;
  isCancelled?: () => boolean;
  enableSupplyAnalysis?: boolean; // Enable supply-adjusted time to sell calculations
  supplyAnalysisConfig?: {
    confidenceWeight?: number; // 0-1, how much to weight supply vs historical (default 0.7)
    maxListingsPerSku?: number; // Performance limit (default 200)
    includeUnverifiedSellers?: boolean; // Include unverified sellers in analysis (default false)
  };
}

export type PricerSku = {
  sku: number;
  quantity?: number;
  addToQuantity?: number;
  currentPrice?: number;
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
  expectedDaysToSell?: number;
  suggestedPrice?: number;
  errors?: string[];
  warnings?: string[];
};
