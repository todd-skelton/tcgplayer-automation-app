import type { Sku } from "../../../shared/data-types/sku";
import {
  getAllLatestSales,
  type Sale,
} from "../../../integrations/tcgplayer/client/get-latest-sales";
import { levenbergMarquardt } from "ml-levenberg-marquardt";
import type { Condition } from "../../../integrations/tcgplayer/types/Condition";
import type { ListingData } from "../services/supplyAnalysisService";
import { SupplyAnalysisService } from "../services/supplyAnalysisService";

// Define condition ordering for Zipf model (from best to worst condition)
const CONDITION_ORDER: Condition[] = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
];

/**
 * Fits a Zipf model to individual sale prices by condition using Levenberg-Marquardt optimization
 * @param sales Array of individual sales with condition and price data
 * @param targetCondition The condition to normalize prices to
 * @returns Object with condition multipliers for normalizing prices
 */
function fitZipfModelToConditions(
  sales: Sale[],
  targetCondition: Condition
): Map<Condition, number> {
  const conditionMultipliers = new Map<Condition, number>();

  // Get all individual sales data points for fitting
  const dataPoints: { x: number; y: number }[] = [];

  sales.forEach((sale) => {
    const condition = sale.condition as Condition;
    const price = sale.purchasePrice || 0;
    const conditionIndex = CONDITION_ORDER.indexOf(condition);

    if (conditionIndex !== -1 && price > 0) {
      // Zipf model: price = a / (rank^b) where rank starts at 1
      dataPoints.push({ x: conditionIndex + 1, y: price });
    }
  });

  if (dataPoints.length < 3) {
    // Not enough data points for fitting, use simple condition-based ratios
    const conditionPrices = calculateConditionPrices(sales);
    const targetPrice = conditionPrices.get(targetCondition);

    CONDITION_ORDER.forEach((condition) => {
      const price = conditionPrices.get(condition);
      if (price && targetPrice && price > 0) {
        conditionMultipliers.set(condition, targetPrice / price);
      } else {
        conditionMultipliers.set(condition, 1.0);
      }
    });
    return conditionMultipliers;
  }

  try {
    // Zipf model: f(x) = a / (x^b)
    const zipfFunction = (parameters: number[]) => (x: number) => {
      const [a, b] = parameters;
      return a / Math.pow(x, b);
    };

    // Use median price of best condition as initial scale parameter
    const bestConditionPrices = dataPoints
      .filter((p) => p.x === 1)
      .map((p) => p.y)
      .sort((a, b) => a - b);

    const initialScale =
      bestConditionPrices.length > 0
        ? bestConditionPrices[Math.floor(bestConditionPrices.length / 2)]
        : dataPoints[0].y;

    // Initial parameters: [a, b] where a is scale factor, b is exponent
    const initialParameters = [initialScale, 0];

    // Fit the model using all individual sale data points
    const data = {
      x: dataPoints.map((p) => p.x),
      y: dataPoints.map((p) => p.y),
    };

    const result = levenbergMarquardt(data, zipfFunction, {
      initialValues: initialParameters,
      minValues: [0, 0],
    });

    const [a, b] = result.parameterValues;

    // Calculate the predicted price for the target condition
    const targetConditionIndex = CONDITION_ORDER.indexOf(targetCondition);
    const targetRank = targetConditionIndex + 1;
    const targetPredictedPrice = a / Math.pow(targetRank, b);

    // Calculate multipliers for each condition based on the fitted model
    CONDITION_ORDER.forEach((condition, index) => {
      const rank = index + 1;
      const predictedPrice = a / Math.pow(rank, b);

      if (predictedPrice > 0 && targetPredictedPrice > 0) {
        // Multiplier to convert from this condition to target condition
        conditionMultipliers.set(
          condition,
          targetPredictedPrice / predictedPrice
        );
      } else {
        conditionMultipliers.set(condition, 1.0);
      }
    });
  } catch (error) {
    console.warn(
      "Zipf model fitting failed, falling back to simple ratios:",
      error
    );

    // Fallback to simple condition-based average ratios
    const conditionPrices = calculateConditionPrices(sales);
    const targetPrice = conditionPrices.get(targetCondition);

    CONDITION_ORDER.forEach((condition) => {
      const price = conditionPrices.get(condition);
      if (price && targetPrice && price > 0) {
        conditionMultipliers.set(condition, targetPrice / price);
      } else {
        conditionMultipliers.set(condition, 1.0);
      }
    });
  }

  return conditionMultipliers;
}

/**
 * Calculate average prices by condition from sales data
 */
function calculateConditionPrices(sales: Sale[]): Map<Condition, number> {
  const conditionSums = new Map<Condition, number>();
  const conditionCounts = new Map<Condition, number>();
  sales.forEach((sale) => {
    const condition = sale.condition as Condition;
    const price = sale.purchasePrice || 0;

    if (price > 0) {
      conditionSums.set(condition, (conditionSums.get(condition) || 0) + price);
      conditionCounts.set(condition, (conditionCounts.get(condition) || 0) + 1);
    }
  });

  const conditionPrices = new Map<Condition, number>();
  conditionSums.forEach((sum, condition) => {
    const count = conditionCounts.get(condition) || 1;
    conditionPrices.set(condition, sum / count);
  });

  return conditionPrices;
}

/**
 * Fetches latest sales for a SKU and computes time-decayed suggested prices across percentiles.
 * Ignores sale quantity to focus on individual willingness to pay rather than bulk purchases.
 * Always fetches sales from all conditions and uses a Zipf model to normalize prices to the target condition.
 * @param sku The SKU object to fetch sales for
 * @param config Optional configuration for halfLifeDays, percentile, etc.
 * @returns Object with suggestedPrice, totalQuantity, saleCount, time estimates in milliseconds, and percentiles array
 */
export async function getSuggestedPriceFromLatestSales(
  sku: Sku,
  config: LatestSalesPriceConfig = {}
): Promise<{
  suggestedPrice?: number;
  totalQuantity: number;
  saleCount: number;
  historicalSalesVelocityMs?: number; // Historical sales intervals (sales velocity only)
  estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
  salesCount?: number; // Number of sales used for the selected percentile historical calculation
  listingsCount?: number; // Number of listings used for the selected percentile estimated calculation
  percentiles: PercentileData[];
  usedCrossConditionAnalysis?: boolean;
  conditionMultipliers?: Map<Condition, number>;
}> {
  const { halfLifeDays = 7, percentile = 80 } = config;

  // Dynamic import of datastores for server-side only
  const { categoryFiltersDb } = await import("../../../datastores");

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
  const languageId = categoryFilter.languages.find(
    (l: any) => l.name === sku.language
  )?.id;
  const variantId = categoryFilter.variants.find(
    (v: any) => v.name === sku.variant
  )?.id;

  // Fetch sales data for all conditions to enable Zipf model normalization
  const salesOptions = {
    conditions: [], // Always fetch all conditions
    languages: languageId ? [languageId] : [],
    variants: variantId ? [variantId] : [],
    listingType: "ListingWithoutPhotos" as const,
  };

  // Fetch up to 100 sales for all conditions
  const allSales: Sale[] = await getAllLatestSales(
    { id: sku.productId },
    salesOptions,
    100
  );

  if (allSales.length < 2) {
    // Not enough data for any meaningful analysis
    return {
      suggestedPrice: undefined,
      totalQuantity: 0,
      saleCount: 0,
      percentiles: [],
      usedCrossConditionAnalysis: false,
    };
  }

  // Calculate condition-based pricing using Zipf model on individual sales
  const zipfMultipliers = fitZipfModelToConditions(allSales, sku.condition);

  // Normalize all sales data to the target condition using Zipf multipliers
  const adjustedSales = allSales.map((sale) => {
    const condition = sale.condition as Condition;
    const multiplier = zipfMultipliers.get(condition) || 1;
    return {
      price: (sale.purchasePrice || 0) * multiplier,
      quantity: sale.quantity || 1,
      timestamp: new Date(sale.orderDate).getTime(),
    };
  });

  // Use dynamic half-life if not provided in config
  const dynamicHalfLife =
    halfLifeDays || calculateDynamicHalfLife(adjustedSales);

  // Handle supply analysis
  let listings: ListingData[] = [];
  if (config.enableSupplyAnalysis && !config.listings) {
    const supplyAnalysisService = new SupplyAnalysisService();

    // Optimization: Calculate max sales price to filter listings
    const maxSalesPrice =
      adjustedSales.length > 0
        ? Math.max(...adjustedSales.map((s) => s.price))
        : undefined;

    const optimizedConfig = {
      ...config.supplyAnalysisConfig,
      maxSalesPrice,
    };

    listings = await supplyAnalysisService.fetchListingsForSku(
      sku,
      optimizedConfig
    );
  } else if (config.listings) {
    listings = config.listings;
  }

  const result = getSuggestedPriceFromSales(adjustedSales, {
    halfLifeDays: dynamicHalfLife,
    percentile,
    listings: config.enableSupplyAnalysis ? listings : undefined,
    supplyAnalysisConfig: config.supplyAnalysisConfig,
  });

  return {
    ...result,
    usedCrossConditionAnalysis: true,
    conditionMultipliers: zipfMultipliers,
  };
}

export interface LatestSalesPriceConfig {
  halfLifeDays?: number; // for time decay
  percentile?: number; // for percentile selection
  enableSupplyAnalysis?: boolean; // Enable market-adjusted time to sell calculations
  supplyAnalysisConfig?: {
    maxListingsPerSku?: number; // Performance limit (default 200)
    includeUnverifiedSellers?: boolean; // Include unverified sellers in analysis (default false)
  };
  listings?: ListingData[]; // Pre-fetched listings data (optional)
}

export interface PercentileData {
  percentile: number;
  price: number;
  historicalSalesVelocityMs?: number; // Historical sales intervals (sales velocity only)
  estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
  salesCount?: number; // Number of sales used for the historical calculation
  listingsCount?: number; // Number of listings used for the estimated calculation
}

/**
 * Calculate time-decay-weighted percentiles from an array of sales with interpolation.
 * Ignores sale quantity to focus on individual willingness to pay rather than bulk purchases.
 * @param sales Array of sales, each with a price, quantity, and a timestamp (ms since epoch)
 * @param options.halfLifeDays Half-life for time decay in days (default 7)
 * @param options.percentiles Array of percentiles to calculate (default: [10,20,30,40,50,60,70,80,90])
 * @returns Array of percentile data with prices and expected time to sell, or empty array if no sales
 */
export function getTimeDecayedPercentileWeightedSuggestedPrice(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: {
    halfLifeDays?: number;
    percentiles?: number[];
    listings?: ListingData[];
    supplyAnalysisConfig?: {
      maxListingsPerSku?: number;
      includeUnverifiedSellers?: boolean;
    };
  } = {}
): PercentileData[] {
  if (!sales || sales.length === 0) return [];

  const halfLifeDays = options.halfLifeDays ?? 7;
  const requestedPercentiles = options.percentiles ?? [
    10, 20, 30, 40, 50, 60, 70, 80, 90,
  ];
  const { listings, supplyAnalysisConfig } = options;

  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;

  // Calculate weights for each sale (weight = time decay only, ignoring quantity)
  // This ensures pricing reflects what individuals are willing to pay, not bulk purchases
  const weightedSales = sales.map((sale) => {
    const ageDays = (now - sale.timestamp) / msPerDay;
    // Exponential decay: weight = 0.5^(age/halfLife)
    const timeWeight = Math.pow(0.5, ageDays / halfLifeDays);
    const weight = timeWeight; // Quantity is intentionally ignored
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

  // Generate percentiles for each requested percentile
  for (const p of requestedPercentiles) {
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

    // Calculate historical sales velocity (historical sales intervals)
    const historicalResult = calculateExpectedTimeToSellMs(sales, price);
    const historicalSalesVelocityMs = historicalResult.timeMs
      ? Math.round(historicalResult.timeMs)
      : undefined;
    const salesCount = historicalResult.salesCount;

    // Calculate supply-adjusted time to sell (if listings are provided)
    let estimatedTimeToSellMs: number | undefined;
    let listingsCount = 0;
    if (listings && listings.length > 0) {
      // Use supply-adjusted time to sell calculation
      const supplyAnalysisService = new SupplyAnalysisService();
      const salesVelocityData = sales.map((s) => ({
        price: s.price,
        quantity: s.quantity,
        timestamp: s.timestamp,
      }));

      const supplyResult =
        supplyAnalysisService.calculateSupplyAdjustedTimeToSell(
          salesVelocityData,
          listings,
          price,
          historicalSalesVelocityMs
        );

      estimatedTimeToSellMs = supplyResult.timeMs
        ? Math.round(supplyResult.timeMs)
        : undefined;
      listingsCount = supplyResult.listingsCount;
    } else {
      // No listings available for estimated time to sell calculation
    }

    // If supply analysis didn't provide a value, fall back to historical sales velocity
    if (estimatedTimeToSellMs === undefined) {
      estimatedTimeToSellMs = historicalSalesVelocityMs;
    }

    percentiles.push({
      percentile: p,
      price,
      historicalSalesVelocityMs,
      estimatedTimeToSellMs,
      salesCount,
      listingsCount,
    });
  }

  return percentiles;
}

/**
 * Convert days to milliseconds
 */
function daysToMilliseconds(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Calculate expected time to sell based on historical sales at or above a given price
 * Returns time in milliseconds and the number of relevant sales
 */
function calculateExpectedTimeToSellMs(
  sales: { price: number; quantity: number; timestamp: number }[],
  targetPrice: number
): { timeMs: number | undefined; salesCount: number } {
  // Filter sales at or above the target price
  const relevantSales = sales
    .filter((s) => s.price >= targetPrice)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (relevantSales.length === 0) {
    return { timeMs: undefined, salesCount: 0 };
  }

  if (relevantSales.length === 1) {
    // For a single sale (e.g., 100th percentile), use 90 days as a reasonable estimate
    return { timeMs: daysToMilliseconds(90), salesCount: 1 };
  }

  // Calculate intervals in milliseconds between relevant sales
  const intervals = [];
  for (let i = 1; i < relevantSales.length; i++) {
    intervals.push(relevantSales[i].timestamp - relevantSales[i - 1].timestamp);
  }

  // Use median interval as expected time to sell
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const timeMs =
    intervals.length % 2 !== 0
      ? intervals[mid]
      : (intervals[mid - 1] + intervals[mid]) / 2;

  return { timeMs: Math.round(timeMs), salesCount: relevantSales.length };
}

/**
 * Calculate expected time to sell based on historical sales at or above a given price
 */
/**
 * Orchestrates the calculation of time-decayed percentile prices from sales data.
 * Ignores sale quantity to focus on individual willingness to pay rather than bulk purchases.
 * @param sales Array of sales, each with price, quantity, and timestamp (ms since epoch)
 * @param options Optional: percentile (0-100, used for backward compatibility), halfLifeDays (default 7)
 * @returns Object with percentile data, suggestedPrice (from specified percentile), and input summary
 */
export function getSuggestedPriceFromSales(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: {
    percentile?: number;
    halfLifeDays?: number;
    listings?: ListingData[];
    supplyAnalysisConfig?: {
      maxListingsPerSku?: number;
      includeUnverifiedSellers?: boolean;
    };
  } = {}
): {
  suggestedPrice?: number;
  totalQuantity: number;
  saleCount: number;
  historicalSalesVelocityMs?: number; // Historical sales intervals (sales velocity only)
  estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
  salesCount?: number; // Number of sales used for the selected percentile historical calculation
  listingsCount?: number; // Number of listings used for the selected percentile estimated calculation
  percentiles: PercentileData[];
} {
  const { percentile = 80, listings, supplyAnalysisConfig } = options;

  // Use dynamic half-life if not provided
  const halfLifeDays = options.halfLifeDays || calculateDynamicHalfLife(sales);

  // Create percentiles array that includes the custom percentile
  const standardPercentiles = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const percentilesToCalculate = [...standardPercentiles];

  // Add custom percentile if it's not already in the standard set
  if (!standardPercentiles.includes(percentile)) {
    percentilesToCalculate.push(percentile);
    percentilesToCalculate.sort((a, b) => a - b); // Keep sorted
  }

  const percentiles = getTimeDecayedPercentileWeightedSuggestedPrice(sales, {
    halfLifeDays,
    percentiles: percentilesToCalculate,
    listings,
    supplyAnalysisConfig,
  });

  const totalQuantity = sales.reduce((sum, s) => sum + (s.quantity || 0), 0);

  // Find the suggested price from the calculated percentiles
  let suggestedPrice: number | undefined = undefined;
  let historicalSalesVelocityMs: number | undefined = undefined;
  let estimatedTimeToSellMs: number | undefined = undefined;
  let selectedSalesCount: number | undefined = undefined;
  let selectedListingsCount: number | undefined = undefined;

  if (sales.length > 0) {
    // Find the percentile data for our target percentile
    const targetPercentileData = percentiles.find(
      (p) => p.percentile === percentile
    );
    if (targetPercentileData) {
      suggestedPrice = targetPercentileData.price;
      historicalSalesVelocityMs =
        targetPercentileData.historicalSalesVelocityMs;
      estimatedTimeToSellMs = targetPercentileData.estimatedTimeToSellMs;
      selectedSalesCount = targetPercentileData.salesCount;
      selectedListingsCount = targetPercentileData.listingsCount;
    }
  }

  return {
    suggestedPrice,
    totalQuantity,
    saleCount: sales.length,
    historicalSalesVelocityMs,
    estimatedTimeToSellMs,
    salesCount: selectedSalesCount,
    listingsCount: selectedListingsCount,
    percentiles,
  };
}

/**
 * Calculate dynamic half-life based on the time span between first and last sale.
 * The half-life is set so that the oldest sale has decayed to 1/16 (4 half-lives) of its original weight.
 * This ensures recent sales are weighted much more heavily than older ones while still considering historical data.
 * @returns Half-life in days
 */
function calculateDynamicHalfLife(
  sales: { price: number; quantity: number; timestamp: number }[]
): number {
  if (sales.length <= 1) {
    return Infinity; // Default to Infinity if not enough sales
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const timestamps = sales.map((s) => s.timestamp).sort((a, b) => a - b);
  const timeSpanMs = timestamps[timestamps.length - 1] - timestamps[0];
  const avgIntervalMs = timeSpanMs / (sales.length - 1);

  // Half-life as a multiple of the average interval
  // (24x is a good starting point to avoid overreacting to single sales)
  let halfLifeMs = avgIntervalMs * 24;

  const minHalfLifeMs = msPerDay;

  // Convert from milliseconds to days before returning
  return Math.max(minHalfLifeMs, Math.round(halfLifeMs)) / msPerDay;
}
