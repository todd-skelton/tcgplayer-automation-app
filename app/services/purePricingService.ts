import type {
  SkuPricingData,
  PurePricingResult,
  BatchPricingData,
  BatchPricingResult,
  PurePricingConfig,
} from "../types/pricingData";
import type { Condition } from "../tcgplayer/types/Condition";
import type { Sale } from "../tcgplayer/get-latest-sales";
import { levenbergMarquardt } from "ml-levenberg-marquardt";
import { SupplyAnalysisService } from "./supplyAnalysisService";
import { calculateMarketplacePrice } from "./pricingService";

/**
 * Pure pricing service that takes pre-gathered data and returns pricing results
 * No external dependencies - fully testable and predictable
 */
export class PurePricingService {
  private supplyAnalysisService = new SupplyAnalysisService();

  /**
   * Calculate prices for a batch of SKUs using pre-gathered data
   */
  calculateBatchPrices(batchData: BatchPricingData): BatchPricingResult {
    const results: PurePricingResult[] = [];
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    let warnings = 0;

    const allPercentileData: Array<{
      percentile: number;
      price: number;
      historicalSalesVelocityMs?: number;
      estimatedTimeToSellMs?: number;
      salesCount?: number;
      quantity: number;
    }> = [];

    // Process each SKU
    for (const skuData of batchData.skusData) {
      try {
        const result = this.calculateSingleSkuPrice(skuData, batchData.config);

        // Track stats
        if (result.errors && result.errors.length > 0) {
          errors++;
        } else if (result.warnings && result.warnings.length > 0) {
          warnings++;
          processed++;
        } else {
          processed++;
        }

        // Collect percentile data for aggregation
        if (result.percentiles && Array.isArray(result.percentiles)) {
          const quantity =
            (skuData.sku.quantity || 0) + (skuData.sku.addToQuantity || 0);
          result.percentiles.forEach((p) => {
            allPercentileData.push({
              percentile: p.percentile,
              price: p.price,
              historicalSalesVelocityMs: p.historicalSalesVelocityMs,
              estimatedTimeToSellMs: p.estimatedTimeToSellMs,
              salesCount: p.salesCount,
              quantity,
            });
          });
        }

        results.push(result);
      } catch (error: any) {
        const errorResult: PurePricingResult = {
          sku: skuData.sku.id,
          errors: [error?.message || "Processing error"],
          percentiles: [],
        };
        results.push(errorResult);
        errors++;
      }
    }

    // Calculate aggregated percentiles
    const aggregatedPercentiles =
      this.calculateAggregatedPercentiles(allPercentileData);

    return {
      results,
      stats: {
        processed,
        skipped,
        errors,
        warnings,
      },
      aggregatedPercentiles,
    };
  }

  /**
   * Calculate price for a single SKU using pre-gathered data
   */
  private calculateSingleSkuPrice(
    skuData: SkuPricingData,
    config: PurePricingConfig
  ): PurePricingResult {
    const result: PurePricingResult = {
      sku: skuData.sku.id,
      percentiles: [],
      errors: [],
      warnings: [],
    };

    // Validate input data
    if (!skuData.sales || skuData.sales.length < 2) {
      result.errors?.push("Insufficient sales data for pricing");
      return result;
    }

    try {
      // Step 1: Apply Zipf model for condition normalization
      const zipfMultipliers = this.fitZipfModelToConditions(
        skuData.sales,
        skuData.sku.condition
      );
      result.conditionMultipliers = zipfMultipliers;
      result.usedCrossConditionAnalysis = true;

      // Step 2: Normalize sales data to target condition
      const adjustedSales = skuData.sales.map((sale) => {
        const condition = sale.condition as Condition;
        const multiplier = zipfMultipliers.get(condition) || 1;
        return {
          price: (sale.purchasePrice || 0) * multiplier,
          quantity: sale.quantity || 1,
          timestamp: new Date(sale.orderDate).getTime(),
        };
      });

      // Step 3: Calculate dynamic half-life
      const dynamicHalfLife =
        config.halfLifeDays || this.calculateDynamicHalfLife(adjustedSales);

      // Step 4: Calculate percentiles with supply analysis
      const percentiles = this.getTimeDecayedPercentileWeightedSuggestedPrice(
        adjustedSales,
        {
          halfLifeDays: dynamicHalfLife,
          percentiles: [10, 20, 30, 40, 50, 60, 70, 80, 90, config.percentile],
          listings: skuData.listings,
          supplyAnalysisConfig: config.supplyAnalysisConfig,
        }
      );

      result.percentiles = percentiles;

      // Step 5: Extract specific percentile result
      const targetPercentileData = percentiles.find(
        (p) => p.percentile === config.percentile
      );

      if (targetPercentileData) {
        result.suggestedPrice = targetPercentileData.price;
        result.historicalSalesVelocityMs =
          targetPercentileData.historicalSalesVelocityMs;
        result.estimatedTimeToSellMs =
          targetPercentileData.estimatedTimeToSellMs;
        result.salesCount = targetPercentileData.salesCount;
        result.listingsCount = targetPercentileData.listingsCount;

        // Step 6: Apply price bounds if price point data is available
        if (skuData.pricePoint && result.suggestedPrice) {
          const { marketplacePrice, warningMessage, errorMessage } =
            calculateMarketplacePrice(result.suggestedPrice, {
              marketPrice: skuData.pricePoint.marketPrice,
              lowestPrice: skuData.pricePoint.lowestPrice,
              highestPrice: skuData.pricePoint.highestPrice,
              calculatedAt: skuData.pricePoint.calculatedAt,
            });

          result.price = marketplacePrice;

          if (warningMessage) {
            result.warnings?.push(warningMessage);
          }
          if (errorMessage) {
            result.errors?.push(errorMessage);
          }
        } else {
          result.price = result.suggestedPrice;
        }
      }

      return result;
    } catch (error: any) {
      result.errors?.push(error?.message || "Pricing calculation failed");
      return result;
    }
  }

  /**
   * Pure Zipf model fitting function (extracted from original algorithm)
   */
  private fitZipfModelToConditions(
    sales: Sale[],
    targetCondition: Condition
  ): Map<Condition, number> {
    const CONDITION_ORDER: Condition[] = [
      "Near Mint",
      "Lightly Played",
      "Moderately Played",
      "Heavily Played",
      "Damaged",
    ];

    const conditionMultipliers = new Map<Condition, number>();

    // Get all individual sales data points for fitting
    const dataPoints: { x: number; y: number }[] = [];

    sales.forEach((sale) => {
      const condition = sale.condition as Condition;
      const price = sale.purchasePrice || 0;
      const conditionIndex = CONDITION_ORDER.indexOf(condition);

      if (conditionIndex !== -1 && price > 0) {
        dataPoints.push({ x: conditionIndex + 1, y: price });
      }
    });

    if (dataPoints.length < 3) {
      // Not enough data points for fitting, use simple condition-based ratios
      const conditionPrices = this.calculateConditionPrices(sales);
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

      const bestConditionPrices = dataPoints
        .filter((p) => p.x === 1)
        .map((p) => p.y)
        .sort((a, b) => a - b);

      const initialScale =
        bestConditionPrices.length > 0
          ? bestConditionPrices[Math.floor(bestConditionPrices.length / 2)]
          : dataPoints[0].y;

      const initialParameters = [initialScale, 0];

      const data = {
        x: dataPoints.map((p) => p.x),
        y: dataPoints.map((p) => p.y),
      };

      const result = levenbergMarquardt(data, zipfFunction, {
        initialValues: initialParameters,
        minValues: [0, 0],
      });

      const [a, b] = result.parameterValues;
      const targetConditionIndex = CONDITION_ORDER.indexOf(targetCondition);
      const targetRank = targetConditionIndex + 1;
      const targetPredictedPrice = a / Math.pow(targetRank, b);

      CONDITION_ORDER.forEach((condition, index) => {
        const rank = index + 1;
        const predictedPrice = a / Math.pow(rank, b);

        if (predictedPrice > 0 && targetPredictedPrice > 0) {
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

      const conditionPrices = this.calculateConditionPrices(sales);
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
  private calculateConditionPrices(sales: Sale[]): Map<Condition, number> {
    const conditionSums = new Map<Condition, number>();
    const conditionCounts = new Map<Condition, number>();

    sales.forEach((sale) => {
      const condition = sale.condition as Condition;
      const price = sale.purchasePrice || 0;

      if (price > 0) {
        conditionSums.set(
          condition,
          (conditionSums.get(condition) || 0) + price
        );
        conditionCounts.set(
          condition,
          (conditionCounts.get(condition) || 0) + 1
        );
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
   * Pure percentile calculation function (extracted from original algorithm)
   */
  private getTimeDecayedPercentileWeightedSuggestedPrice(
    sales: { price: number; quantity: number; timestamp: number }[],
    options: {
      halfLifeDays?: number;
      percentiles?: number[];
      listings?: any[];
      supplyAnalysisConfig?: any;
    } = {}
  ): Array<{
    percentile: number;
    price: number;
    historicalSalesVelocityMs?: number;
    estimatedTimeToSellMs?: number;
    salesCount?: number;
    listingsCount?: number;
  }> {
    if (!sales || sales.length === 0) return [];

    const halfLifeDays = options.halfLifeDays ?? 7;
    const requestedPercentiles = options.percentiles ?? [
      10, 20, 30, 40, 50, 60, 70, 80, 90,
    ];
    const { listings, supplyAnalysisConfig } = options;

    const now = Date.now();
    const msPerDay = 24 * 60 * 60 * 1000;

    // Calculate weights for each sale
    const weightedSales = sales.map((sale) => {
      const ageDays = (now - sale.timestamp) / msPerDay;
      const timeWeight = Math.pow(0.5, ageDays / halfLifeDays);
      const weight = timeWeight * (sale.quantity || 1);
      return { ...sale, weight };
    });

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

    const percentiles: Array<{
      percentile: number;
      price: number;
      historicalSalesVelocityMs?: number;
      estimatedTimeToSellMs?: number;
      salesCount?: number;
      listingsCount?: number;
    }> = [];

    // Generate percentiles
    for (const p of requestedPercentiles) {
      const targetWeight = (p / 100) * totalWeight;
      let price: number;

      if (p === 0) {
        price = cumulativeData[0].price;
      } else if (p === 100) {
        price = cumulativeData[cumulativeData.length - 1].price;
      } else {
        // Interpolation logic
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
          price = cumulativeData[cumulativeData.length - 1].price;
        } else if (lowerIndex === upperIndex) {
          price = cumulativeData[upperIndex].price;
        } else {
          const lower = cumulativeData[lowerIndex];
          const upper = cumulativeData[upperIndex];
          const weightDiff = upper.cumulativeWeight - lower.cumulativeWeight;
          const targetOffset = targetWeight - lower.cumulativeWeight;
          const ratio = weightDiff === 0 ? 0 : targetOffset / weightDiff;
          price = lower.price + (upper.price - lower.price) * ratio;
        }
      }

      // Calculate historical sales velocity
      const historicalResult = this.calculateExpectedTimeToSellMs(sales, price);
      const historicalSalesVelocityMs = historicalResult.timeMs
        ? Math.round(historicalResult.timeMs)
        : undefined;
      const salesCount = historicalResult.salesCount;

      // Calculate supply-adjusted time to sell (if listings are provided)
      let estimatedTimeToSellMs: number | undefined;
      let listingsCount = 0;

      if (listings && listings.length > 0) {
        const salesVelocityData = sales.map((s) => ({
          price: s.price,
          quantity: s.quantity,
          timestamp: s.timestamp,
        }));

        const supplyResult =
          this.supplyAnalysisService.calculateSupplyAdjustedTimeToSell(
            salesVelocityData,
            listings,
            price,
            historicalSalesVelocityMs
          );

        estimatedTimeToSellMs = supplyResult.timeMs
          ? Math.round(supplyResult.timeMs)
          : undefined;
        listingsCount = supplyResult.listingsCount;
      }

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
   * Calculate expected time to sell based on historical sales
   */
  private calculateExpectedTimeToSellMs(
    sales: { price: number; quantity: number; timestamp: number }[],
    targetPrice: number
  ): { timeMs: number | undefined; salesCount: number } {
    const relevantSales = sales
      .filter((s) => s.price >= targetPrice)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (relevantSales.length === 0) {
      return { timeMs: undefined, salesCount: 0 };
    }

    if (relevantSales.length === 1) {
      return { timeMs: 90 * 24 * 60 * 60 * 1000, salesCount: 1 }; // 90 days in ms
    }

    const intervals = [];
    for (let i = 1; i < relevantSales.length; i++) {
      intervals.push(
        relevantSales[i].timestamp - relevantSales[i - 1].timestamp
      );
    }

    intervals.sort((a, b) => a - b);
    const mid = Math.floor(intervals.length / 2);
    const timeMs =
      intervals.length % 2 !== 0
        ? intervals[mid]
        : (intervals[mid - 1] + intervals[mid]) / 2;

    return { timeMs: Math.round(timeMs), salesCount: relevantSales.length };
  }

  /**
   * Calculate dynamic half-life based on sales data
   */
  private calculateDynamicHalfLife(
    sales: { price: number; quantity: number; timestamp: number }[]
  ): number {
    if (sales.length <= 1) {
      return 7; // Default to 7 days
    }

    const msPerDay = 24 * 60 * 60 * 1000;
    const timestamps = sales.map((s) => s.timestamp).sort((a, b) => a - b);
    const timeSpanMs = timestamps[timestamps.length - 1] - timestamps[0];
    const avgIntervalMs = timeSpanMs / (sales.length - 1);

    let halfLifeMs = avgIntervalMs * 24;
    const minHalfLifeMs = msPerDay;

    return Math.max(minHalfLifeMs, Math.round(halfLifeMs)) / msPerDay;
  }

  /**
   * Calculate aggregated percentiles for summary statistics
   */
  private calculateAggregatedPercentiles(
    percentileData: Array<{
      percentile: number;
      price: number;
      historicalSalesVelocityMs?: number;
      estimatedTimeToSellMs?: number;
      salesCount?: number;
      quantity: number;
    }>
  ): {
    marketPrice: { [key: string]: number };
    historicalSalesVelocity: { [key: string]: number };
    estimatedTimeToSell: { [key: string]: number };
  } {
    const aggregated = {
      marketPrice: {} as { [key: string]: number },
      historicalSalesVelocity: {} as { [key: string]: number },
      estimatedTimeToSell: {} as { [key: string]: number },
    };

    // Group by percentile
    const percentileGroups: { [key: number]: typeof percentileData } = {};

    percentileData.forEach((item) => {
      if (!percentileGroups[item.percentile]) {
        percentileGroups[item.percentile] = [];
      }
      percentileGroups[item.percentile].push(item);
    });

    // Calculate totals for each percentile
    Object.entries(percentileGroups).forEach(([percentile, items]) => {
      let totalValue = 0;
      let totalQuantity = 0;

      items.forEach((item) => {
        const quantity = item.quantity || 1;
        totalValue += item.price * quantity;
        totalQuantity += quantity;
      });

      aggregated.marketPrice[`${percentile}th`] = totalValue;

      if (totalQuantity > 0) {
        // Calculate median historical sales velocity
        const historicalVelocityValues = items
          .map((item) => {
            const timeMs = item.historicalSalesVelocityMs;
            return timeMs ? timeMs / (24 * 60 * 60 * 1000) : undefined;
          })
          .filter((value): value is number => value !== undefined)
          .sort((a, b) => a - b);

        if (historicalVelocityValues.length > 0) {
          const midIndex = Math.floor(historicalVelocityValues.length / 2);
          const median =
            historicalVelocityValues.length % 2 === 0
              ? (historicalVelocityValues[midIndex - 1] +
                  historicalVelocityValues[midIndex]) /
                2
              : historicalVelocityValues[midIndex];

          aggregated.historicalSalesVelocity[`${percentile}th`] = median;
        }

        // Calculate median market-adjusted time to sell
        const marketAdjustedValues = items
          .map((item) => {
            const timeMs = item.estimatedTimeToSellMs;
            return timeMs ? timeMs / (24 * 60 * 60 * 1000) : undefined;
          })
          .filter((value): value is number => value !== undefined)
          .sort((a, b) => a - b);

        if (marketAdjustedValues.length > 0) {
          const midIndex = Math.floor(marketAdjustedValues.length / 2);
          const median =
            marketAdjustedValues.length % 2 === 0
              ? (marketAdjustedValues[midIndex - 1] +
                  marketAdjustedValues[midIndex]) /
                2
              : marketAdjustedValues[midIndex];

          aggregated.estimatedTimeToSell[`${percentile}th`] = median;
        }
      }
    });

    return aggregated;
  }
}
