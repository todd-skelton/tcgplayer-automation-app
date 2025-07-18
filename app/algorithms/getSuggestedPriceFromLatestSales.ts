import type { Sku } from "../data-types/sku";
import { getAllLatestSales, type Sale } from "../tcgplayer/get-latest-sales";
import { categoryFiltersDb } from "../datastores";
import { levenbergMarquardt } from "ml-levenberg-marquardt";
import type { Condition } from "../tcgplayer/types/Condition";

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

    console.log(
      `Zipf model fitted with parameters: a=${a.toFixed(3)}, b=${b.toFixed(3)}`
    );
    console.log(`Using ${dataPoints.length} individual sales data points`);
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
 * Fetches latest sales for a SKU and computes time-decayed, quantity-weighted suggested prices across percentiles.
 * If the target condition has fewer than 5 sales, it will fetch sales from all conditions,
 * fit a Zipf model to normalize prices, and provide a more robust price suggestion.
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
  usedCrossConditionAnalysis?: boolean;
  conditionMultipliers?: Map<Condition, number>;
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

  // Cap to 50 sales for initial check
  const sales: Sale[] = await getAllLatestSales(
    { id: sku.productId },
    { ...salesOptions },
    50
  );

  // Check if we have fewer than 5 sales for the specific condition
  if (sales.length < 5) {
    console.log(
      `Only ${sales.length} sales found for ${sku.condition}, fetching all conditions for Zipf analysis`
    );

    // Fetch sales data for all conditions
    const allConditionsSalesOptions = {
      conditions: undefined, // Remove condition filter to get all conditions
      languages: languageId ? [languageId] : undefined,
      variants: variantId ? [variantId] : undefined,
      listingType: "ListingWithoutPhotos" as const,
    };

    const allSales: Sale[] = await getAllLatestSales(
      { id: sku.productId },
      allConditionsSalesOptions,
      100 // Get more sales for cross-condition analysis
    );

    if (allSales.length < 2) {
      // Still not enough data, return the original result with limited data
      const mappedSales = sales.map((s) => ({
        price: s.purchasePrice || 0,
        quantity: s.quantity || 1,
        timestamp: new Date(s.orderDate).getTime(),
      }));

      const dynamicHalfLife =
        halfLifeDays || calculateDynamicHalfLife(mappedSales);
      return {
        ...getSuggestedPriceFromSales(mappedSales, {
          halfLifeDays: dynamicHalfLife,
          percentile,
        }),
        usedCrossConditionAnalysis: false,
      };
    } // Calculate condition-based pricing using Zipf model on individual sales
    const zipfMultipliers = fitZipfModelToConditions(allSales, sku.condition);
    console.log("Zipf multipliers:", Object.fromEntries(zipfMultipliers));

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

    const result = getSuggestedPriceFromSales(adjustedSales, {
      halfLifeDays: dynamicHalfLife,
      percentile,
    });

    return {
      ...result,
      usedCrossConditionAnalysis: true,
      conditionMultipliers: zipfMultipliers,
    };
  }

  // Standard processing for when we have enough sales for the specific condition
  const mappedSales = sales.map((s) => ({
    price: s.purchasePrice || 0,
    quantity: s.quantity || 1,
    timestamp: new Date(s.orderDate).getTime(),
  }));

  // Use dynamic half-life if not provided in config
  const dynamicHalfLife = halfLifeDays || calculateDynamicHalfLife(mappedSales);

  const result = getSuggestedPriceFromSales(mappedSales, {
    halfLifeDays: dynamicHalfLife,
    percentile,
  });

  return {
    ...result,
    usedCrossConditionAnalysis: false,
  };
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
 * @param sales Array of sales, each with a price, quantity, and a timestamp (ms since epoch)
 * @param options.halfLifeDays Half-life for time decay in days (default 7)
 * @param options.percentiles Array of percentiles to calculate (default: [0,10,20,...,100])
 * @returns Array of percentile data with prices and expected time to sell, or empty array if no sales
 */
export function getTimeDecayedPercentileWeightedSuggestedPrice(
  sales: { price: number; quantity: number; timestamp: number }[],
  options: { halfLifeDays?: number; percentiles?: number[] } = {}
): PercentileData[] {
  if (!sales || sales.length === 0) return [];

  const halfLifeDays = options.halfLifeDays ?? 7;
  const requestedPercentiles = options.percentiles ?? [
    0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
  ];

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

  if (relevantSales.length < 2) {
    return Infinity;
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

  // Create percentiles array that includes the custom percentile
  const standardPercentiles = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const percentilesToCalculate = [...standardPercentiles];

  // Add custom percentile if it's not already in the standard set
  if (!standardPercentiles.includes(percentile)) {
    percentilesToCalculate.push(percentile);
    percentilesToCalculate.sort((a, b) => a - b); // Keep sorted
  }

  const percentiles = getTimeDecayedPercentileWeightedSuggestedPrice(sales, {
    halfLifeDays,
    percentiles: percentilesToCalculate,
  });

  const totalQuantity = sales.reduce((sum, s) => sum + (s.quantity || 0), 0);

  // Find the suggested price from the calculated percentiles
  let suggestedPrice: number | undefined = undefined;
  let expectedTimeToSellDays: number | undefined = undefined;

  if (sales.length > 0) {
    // Find the percentile data for our target percentile
    const targetPercentileData = percentiles.find(
      (p) => p.percentile === percentile
    );
    if (targetPercentileData) {
      suggestedPrice = targetPercentileData.price;
      expectedTimeToSellDays = targetPercentileData.expectedTimeToSellDays;
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
 * Calculate dynamic half-life based on the time span between first and last sale.
 * The half-life is set so that the oldest sale has decayed to 1/16 (4 half-lives) of its original weight.
 * This ensures recent sales are weighted much more heavily than older ones while still considering historical data.
 */
function calculateDynamicHalfLife(
  sales: { price: number; quantity: number; timestamp: number }[]
): number {
  if (!sales || sales.length === 0) {
    return 14; // Default to 14 days for items with no sales data
  }

  if (sales.length === 1) {
    return 7; // Default to 7 days for single sale
  }

  // Calculate time span between first and last sale
  const timestamps = sales.map((s) => s.timestamp).sort((a, b) => a - b);
  const timeSpanDays =
    (timestamps[timestamps.length - 1] - timestamps[0]) / (24 * 60 * 60 * 1000);

  if (timeSpanDays === 0) {
    return 7; // Default to 7 days if all sales are on the same day
  }

  // Set half-life so that the oldest sale is worth 4 half-lives
  // After 4 half-lives, weight = 0.5^4 = 1/16 = 6.25% of original
  const halfLife = timeSpanDays / 4;

  // Apply reasonable bounds: minimum 1 day, maximum 90 days
  return Math.max(1, Math.min(90, Math.round(halfLife * 10) / 10));
}
