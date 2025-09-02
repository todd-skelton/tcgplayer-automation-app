/**
 * Pure data structures for the pricing pipeline
 * These contain all data needed for pricing without external dependencies
 */

import type { Condition } from "../tcgplayer/types/Condition";
import type { Sale } from "../tcgplayer/get-latest-sales";
import type { ListingData } from "../services/supplyAnalysisService";
import type { PricePoint } from "../tcgplayer/get-price-points";

/**
 * Complete data bundle for a single SKU pricing operation
 * Contains all external data pre-fetched and ready for processing
 */
export interface SkuPricingData {
  sku: {
    id: number;
    productId: number;
    productLineId: number;
    condition: Condition;
    language: string;
    variant: string;
    quantity?: number;
    addToQuantity?: number;
    currentPrice?: number;
  };
  sales: Sale[];
  categoryFilter: {
    categoryId: number;
    languages: Array<{ id: number; name: string }>;
    variants: Array<{ id: number; name: string }>;
  };
  listings?: ListingData[];
  pricePoint?: PricePoint;
  productInfo?: {
    productLine: string;
    setName: string;
    productName: string;
    condition: string;
    variant: string;
  };
}

/**
 * Configuration for pricing algorithms (pure config, no external dependencies)
 */
export interface PurePricingConfig {
  percentile: number;
  halfLifeDays?: number;
  enableSupplyAnalysis: boolean;
  supplyAnalysisConfig?: {
    maxListingsPerSku?: number;
    includeUnverifiedSellers?: boolean;
  };
}

/**
 * Result from pure pricing function
 */
export interface PurePricingResult {
  sku: number;
  suggestedPrice?: number;
  price?: number;
  historicalSalesVelocityMs?: number;
  estimatedTimeToSellMs?: number;
  salesCount?: number;
  listingsCount?: number;
  percentiles: Array<{
    percentile: number;
    price: number;
    historicalSalesVelocityMs?: number;
    estimatedTimeToSellMs?: number;
    salesCount?: number;
    listingsCount?: number;
  }>;
  usedCrossConditionAnalysis?: boolean;
  conditionMultipliers?: Map<Condition, number>;
  errors?: string[];
  warnings?: string[];
}

/**
 * Batch pricing input - contains all data for multiple SKUs
 */
export interface BatchPricingData {
  skusData: SkuPricingData[];
  config: PurePricingConfig;
}

/**
 * Batch pricing result
 */
export interface BatchPricingResult {
  results: PurePricingResult[];
  stats: {
    processed: number;
    skipped: number;
    errors: number;
    warnings: number;
  };
  aggregatedPercentiles: {
    marketPrice: { [key: string]: number };
    historicalSalesVelocity: { [key: string]: number };
    estimatedTimeToSell: { [key: string]: number };
  };
}
