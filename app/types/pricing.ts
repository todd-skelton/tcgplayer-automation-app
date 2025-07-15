export interface TcgPlayerListing {
  "TCGplayer Id": string;
  "Product Line": string;
  "Set Name": string;
  "Product Name": string;
  Title?: string;
  Number?: string;
  Rarity?: string;
  Condition?: string;
  "TCG Market Price"?: string;
  "TCG Direct Low"?: string;
  "TCG Low Price With Shipping"?: string;
  "TCG Low Price"?: string;
  "Total Quantity": string;
  "Add to Quantity": string;
  "TCG Marketplace Price": string;
  "Photo URL"?: string;
  "Previous Marketplace Price"?: string;
  "Expected Days to Sell"?: string;
  "Suggested Price"?: string;
  Error?: string;
  [key: string]: string | undefined;
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
