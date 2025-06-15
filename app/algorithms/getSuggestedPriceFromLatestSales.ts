import type { Sku } from "../data-types/sku";
import { getAllLatestSales, type Sale } from "../tcgplayer/get-latest-sales";
import { categoryFiltersDb } from "../datastores";

/**
 * Fetches latest sales for a SKU and computes time-decayed, quantity-weighted suggested prices across percentiles.
 * @param sku The SKU object to fetch sales for
 * @param config Optional configuration for halfLifeDays, percentile, etc.
 * @returns Object with suggestedPrice, totalQuantity, saleCount, expectedTimeToSellDays, and percentiles array
 */
export async function getSuggestedPriceFromLatestSales(
  sku: Sku,
  config: LatestSalesPriceConfig = {}
): Promise<{
  suggestedPrice?: number;
  totalQuantity: number;
  saleCount: number;
  expectedTimeToSellDays?: number;
  percentiles: PercentileData[];
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
  ); // Map to required format
  const mappedSales = sales.map((s) => ({
    price: s.purchasePrice || 0,
    quantity: s.quantity || 1,
    timestamp: new Date(s.orderDate).getTime(),
  }));

  // Use dynamic half-life if not provided in config
  const dynamicHalfLife = halfLifeDays || calculateDynamicHalfLife(mappedSales);

  return getSuggestedPriceFromSales(mappedSales, {
    halfLifeDays: dynamicHalfLife,
    percentile,
  });
}

export interface LatestSalesPriceConfig {
  halfLifeDays?: number; // for time decay
  percentile?: number; // for percentile selection
}

export interface PercentileData {
  percentile: number;
  price: number;
  expectedTimeToSellDays?: number;
}

/**
 * Calculate time-decay-weighted percentiles from an array of sales with interpolation.
 * Returns percentiles from 0 to 100 in 10s intervals with interpolated prices between actual data points.
 * @param sales Array of sales, each with a price, quantity, and a timestamp (ms since epoch)
 * @param options.halfLifeDays Half-life for time decay in days (default 7)
 * @returns Array of percentile data with prices and expected time to sell, or empty array if no sales
 */
export function getTimeDecayedPercentileWeightedSuggestedPrice(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: { halfLifeDays?: number } = {}
): PercentileData[] {
  if (!sales || sales.length === 0) return [];

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
  if (totalWeight === 0) return [];

  // Calculate cumulative weights for interpolation
  let cumulative = 0;
  const cumulativeData = weightedSales.map((sale) => {
    cumulative += sale.weight;
    return {
      price: sale.price,
      cumulativeWeight: cumulative,
      percentile: (cumulative / totalWeight) * 100,
    };
  });

  const percentiles: PercentileData[] = [];

  // Generate percentiles from 0 to 100 in 10s intervals
  for (let p = 0; p <= 100; p += 10) {
    const targetWeight = (p / 100) * totalWeight;
    let price: number;

    if (p === 0) {
      price = cumulativeData[0].price;
    } else if (p === 100) {
      price = cumulativeData[cumulativeData.length - 1].price;
    } else {
      // Find the two data points to interpolate between
      let lowerIndex = -1;
      let upperIndex = -1;

      for (let i = 0; i < cumulativeData.length; i++) {
        if (cumulativeData[i].cumulativeWeight >= targetWeight) {
          upperIndex = i;
          lowerIndex = i === 0 ? 0 : i - 1;
          break;
        }
      }

      if (upperIndex === -1) {
        // Target weight is higher than all data, use highest price
        price = cumulativeData[cumulativeData.length - 1].price;
      } else if (lowerIndex === upperIndex) {
        // Exact match or first data point
        price = cumulativeData[upperIndex].price;
      } else {
        // Interpolate between the two points
        const lower = cumulativeData[lowerIndex];
        const upper = cumulativeData[upperIndex];
        const weightDiff = upper.cumulativeWeight - lower.cumulativeWeight;
        const targetOffset = targetWeight - lower.cumulativeWeight;
        const ratio = weightDiff === 0 ? 0 : targetOffset / weightDiff;
        price = lower.price + (upper.price - lower.price) * ratio;
      }
    }

    // Calculate expected time to sell for this percentile price
    const expectedTimeToSellDays = calculateExpectedTimeToSell(sales, price);

    percentiles.push({
      percentile: p,
      price,
      expectedTimeToSellDays,
    });
  }

  return percentiles;
}

/**
 * Calculate expected time to sell based on historical sales at or above a given price
 */
function calculateExpectedTimeToSell(
  sales: { price: number; quantity: number; timestamp: number }[],
  targetPrice: number
): number | undefined {
  // Filter sales at or above the target price
  const relevantSales = sales
    .filter((s) => s.price >= targetPrice)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (relevantSales.length <= 1) {
    return undefined;
  }

  // Calculate intervals in days between relevant sales
  const intervals = [];
  for (let i = 1; i < relevantSales.length; i++) {
    intervals.push(
      (relevantSales[i].timestamp - relevantSales[i - 1].timestamp) /
        (1000 * 60 * 60 * 24)
    );
  }

  // Use median interval as expected time to sell
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  return intervals.length % 2 !== 0
    ? intervals[mid]
    : (intervals[mid - 1] + intervals[mid]) / 2;
}

/**
 * Orchestrates the calculation of time-decayed, quantity-weighted percentile prices from sales data.
 * @param sales Array of sales, each with price, quantity, and timestamp (ms since epoch)
 * @param options Optional: percentile (0-100, used for backward compatibility), halfLifeDays (default 7)
 * @returns Object with percentile data, suggestedPrice (from specified percentile), and input summary
 */
export function getSuggestedPriceFromSales(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: { percentile?: number; halfLifeDays?: number } = {}
): {
  suggestedPrice?: number;
  totalQuantity: number;
  saleCount: number;
  expectedTimeToSellDays?: number;
  percentiles: PercentileData[];
} {
  const { percentile = 80 } = options;

  // Use dynamic half-life if not provided
  const halfLifeDays = options.halfLifeDays || calculateDynamicHalfLife(sales);

  const percentiles = getTimeDecayedPercentileWeightedSuggestedPrice(sales, {
    halfLifeDays,
  });

  const totalQuantity = sales.reduce((sum, s) => sum + (s.quantity || 0), 0);

  // Find the requested percentile for backward compatibility
  let suggestedPrice: number | undefined = undefined;
  let expectedTimeToSellDays: number | undefined = undefined;

  if (percentiles.length > 0) {
    // Find the closest percentile to the requested one
    const targetPercentile = percentiles.reduce((prev, curr) => {
      return Math.abs(curr.percentile - percentile) <
        Math.abs(prev.percentile - percentile)
        ? curr
        : prev;
    });

    // If exact match not found, interpolate
    if (targetPercentile.percentile !== percentile) {
      const lowerPercentile = percentiles
        .filter((p) => p.percentile <= percentile)
        .pop();
      const upperPercentile = percentiles.find(
        (p) => p.percentile >= percentile
      );

      if (
        lowerPercentile &&
        upperPercentile &&
        lowerPercentile !== upperPercentile
      ) {
        const ratio =
          (percentile - lowerPercentile.percentile) /
          (upperPercentile.percentile - lowerPercentile.percentile);
        suggestedPrice =
          lowerPercentile.price +
          (upperPercentile.price - lowerPercentile.price) * ratio;

        // Interpolate expected time to sell as well
        if (
          lowerPercentile.expectedTimeToSellDays !== undefined &&
          upperPercentile.expectedTimeToSellDays !== undefined
        ) {
          expectedTimeToSellDays =
            lowerPercentile.expectedTimeToSellDays +
            (upperPercentile.expectedTimeToSellDays -
              lowerPercentile.expectedTimeToSellDays) *
              ratio;
        } else {
          expectedTimeToSellDays =
            lowerPercentile.expectedTimeToSellDays ||
            upperPercentile.expectedTimeToSellDays;
        }
      } else {
        suggestedPrice = targetPercentile.price;
        expectedTimeToSellDays = targetPercentile.expectedTimeToSellDays;
      }
    } else {
      suggestedPrice = targetPercentile.price;
      expectedTimeToSellDays = targetPercentile.expectedTimeToSellDays;
    }
  }

  return {
    suggestedPrice,
    totalQuantity,
    saleCount: sales.length,
    expectedTimeToSellDays,
    percentiles,
  };
}

/**
 * Calculate dynamic half-life based on sales volume and frequency
 * High volume = shorter half-life (more responsive)
 * Low volume = longer half-life (more stable)
 */
function calculateDynamicHalfLife(
  sales: { price: number; quantity: number; timestamp: number }[]
): number {
  if (!sales || sales.length === 0) {
    return 14; // Default to 14 days for items with no sales data
  }

  // Calculate sales metrics
  const totalQuantity = sales.reduce((sum, s) => sum + (s.quantity || 0), 0);
  const saleCount = sales.length;
  const avgQuantityPerSale = totalQuantity / saleCount;

  // Calculate time span of sales data
  const timestamps = sales.map((s) => s.timestamp).sort((a, b) => a - b);
  const timeSpanDays =
    (timestamps[timestamps.length - 1] - timestamps[0]) / (24 * 60 * 60 * 1000);
  const salesFrequency = timeSpanDays > 0 ? saleCount / timeSpanDays : 0;

  // Volume score: combination of total quantity, sale frequency, and average quantity per sale
  const volumeScore =
    totalQuantity * 0.4 + salesFrequency * 10 * 0.4 + avgQuantityPerSale * 0.2;

  // Map volume score to half-life (inverse relationship)
  // High volume (score > 20) -> 3-5 days
  // Medium volume (score 5-20) -> 5-10 days
  // Low volume (score < 5) -> 10-21 days
  let halfLife: number;

  if (volumeScore >= 20) {
    // High volume: very responsive to recent changes
    halfLife = Math.max(3, 8 - (volumeScore - 20) * 0.1);
  } else if (volumeScore >= 5) {
    // Medium volume: moderately responsive
    halfLife = 5 + (20 - volumeScore) * 0.33;
  } else {
    // Low volume: more stable, longer half-life
    halfLife = Math.min(21, 10 + (5 - volumeScore) * 2);
  }

  return Math.round(halfLife * 10) / 10; // Round to 1 decimal place
}
