import type { Sku } from "../data-types/sku";
import { getAllLatestSales, type Sale } from "../tcgplayer/get-latest-sales";
import { categoryFiltersDb } from "../datastores";

/**
 * Fetches latest sales for a SKU and computes a time-decayed, quantity-weighted suggested price.
 * @param sku The SKU object to fetch sales for
 * @param config Optional configuration for halfLifeDays, percentile, etc.
 * @returns Object with suggestedPrice, totalQuantity, and saleCount
 */
export async function getSuggestedPriceFromLatestSales(
  sku: Sku,
  config: LatestSalesPriceConfig = {}
): Promise<{
  suggestedPrice?: number;
  totalQuantity: number;
  saleCount: number;
}> {
  const { halfLifeDays = 7, percentile = 80 } = config;

  // Fetch category filter for this SKU's productLineId (which is used as categoryId)
  const categoryFilter = await categoryFiltersDb.findOne({
    categoryId: sku.productLineId,
  });
  if (!categoryFilter) {
    throw new Error(
      `No category filter found for categoryId (productLineId) ${sku.productLineId}`
    );
  }

  // Map string values to IDs for salesOptions using category filter
  const conditionId = categoryFilter.conditions.find(
    (c) => c.name === sku.condition
  )?.id;
  const languageId = categoryFilter.languages.find(
    (l) => l.name === sku.language
  )?.id;
  const variantId = categoryFilter.variants.find(
    (v) => v.name === sku.variant
  )?.id;

  const salesOptions = {
    conditions: conditionId ? [conditionId] : undefined,
    languages: languageId ? [languageId] : undefined,
    variants: variantId ? [variantId] : undefined,
    listingType: "ListingWithoutPhotos" as const,
  };

  // Cap to 50 sales
  const sales: Sale[] = await getAllLatestSales(
    { id: sku.productId },
    { ...salesOptions },
    50
  );
  // Map to required format
  const mappedSales = sales.map((s) => ({
    price: s.purchasePrice || 0,
    quantity: s.quantity || 1,
    timestamp: new Date(s.orderDate).getTime(),
  }));
  // Use config for percentile and halfLifeDays
  return getSuggestedPriceFromSales(mappedSales, { halfLifeDays, percentile });
}

export interface LatestSalesPriceConfig {
  halfLifeDays?: number; // for time decay
  percentile?: number; // for percentile selection
}

/**
 * Calculate a time-decay-weighted percentile from an array of sales.
 * Newer sales and higher-quantity sales are given more weight using an exponential decay model.
 * @param sales Array of sales, each with a price, quantity, and a timestamp (ms since epoch)
 * @param options.percentile Percentile to calculate (0-100, default 50)
 * @param options.halfLifeDays Half-life for time decay in days (default 7)
 * @returns Weighted percentile price, or undefined if no sales
 */
export function getTimeDecayedPercentileWeightedSuggestedPrice(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: { percentile?: number; halfLifeDays?: number } = {}
): number | undefined {
  if (!sales || sales.length === 0) return undefined;
  const percentile = options.percentile ?? 50;
  const halfLifeDays = options.halfLifeDays ?? 7;
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  // Calculate weights for each sale (weight = time decay * quantity)
  const weightedSales = sales.map((sale) => {
    const ageDays = (now - sale.timestamp) / msPerDay;
    // Exponential decay: weight = 0.5^(age/halfLife) * quantity
    const timeWeight = Math.pow(0.5, ageDays / halfLifeDays);
    const weight = timeWeight * (sale.quantity || 1);
    return { ...sale, weight };
  });
  // Sort by price ascending
  weightedSales.sort((a, b) => a.price - b.price);
  const totalWeight = weightedSales.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return undefined;
  // Find the price at the weighted percentile (by cumulative weighted quantity)
  const targetWeight = (percentile / 100) * totalWeight;
  let cumulative = 0;
  for (const s of weightedSales) {
    cumulative += s.weight;
    if (cumulative >= targetWeight) {
      return s.price;
    }
  }
  // Fallback: return highest price
  return weightedSales[weightedSales.length - 1].price;
}

/**
 * Orchestrates the calculation of a time-decayed, quantity-weighted percentile price from sales data.
 * @param sales Array of sales, each with price, quantity, and timestamp (ms since epoch)
 * @param options Optional: percentile (0-100), halfLifeDays (default 7)
 * @returns Object with suggestedPrice and input summary
 */
export function getSuggestedPriceFromSales(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: { percentile?: number; halfLifeDays?: number } = {}
): { suggestedPrice?: number; totalQuantity: number; saleCount: number } {
  const suggestedPrice = getTimeDecayedPercentileWeightedSuggestedPrice(
    sales,
    options
  );
  const totalQuantity = sales.reduce((sum, s) => sum + (s.quantity || 0), 0);
  return {
    suggestedPrice,
    totalQuantity,
    saleCount: sales.length,
  };
}
