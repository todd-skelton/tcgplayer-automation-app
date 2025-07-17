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
}

export interface ProcessingProgress {
  current: number;
  total: number;
  status: string;
  processed: number;
  skipped: number;
  errors: number;
}

export interface ProcessingSummary {
  totalRows: number;
  processedRows: number;
  skippedRows: number;
  errorRows: number;
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
    expectedDaysToSell: number;
    percentiles: { [key: string]: number };
  };
}

export interface SuggestedPriceResult {
  error?: string;
  suggestedPrice: number | null;
  expectedTimeToSellDays?: number;
  percentiles?: Array<{
    percentile: number;
    price: number;
    expectedTimeToSellDays?: number;
  }>;
}

export interface PricingConfig {
  percentile: number;
  onProgress?: (progress: ProcessingProgress) => void;
  onError?: (error: string) => void;
  isCancelled?: () => boolean;
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
};
