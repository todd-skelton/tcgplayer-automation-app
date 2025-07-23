import type { PricerSku, PricingConfig } from "../types/pricing";
import { getSuggestedPrice } from "./pricingService";
import { calculateMarketplacePrice } from "./pricingService";
import type { PricePoint } from "../tcgplayer/get-price-points";
import type { ProductDisplayInfo } from "./dataEnrichmentService";

export interface PricingResult {
  sku: number;
  quantity?: number;
  addToQuantity?: number;
  previousPrice?: number;
  suggestedPrice?: number;
  price?: number;
  historicalSalesVelocityDays?: number; // Historical sales velocity in days
  estimatedTimeToSellDays?: number; // Market-adjusted time to sell in days
  salesCountForHistorical?: number; // Number of sales used for historical calculation
  errors?: string[];
  warnings?: string[];
}

export interface PricingCalculationResult {
  pricedItems: PricingResult[];
  stats: {
    processed: number;
    skipped: number;
    errors: number;
    warnings: number;
    processingTime: number;
  };
  aggregatedPercentiles: {
    marketPrice: { [key: string]: number };
    historicalSalesVelocity: { [key: string]: number };
    estimatedTimeToSell: { [key: string]: number };
  };
}

/**
 * Core pricing calculator that only handles price calculation.
 * No data enrichment, no file operations, no UI concerns.
 */
export class PricingCalculator {
  async calculatePrices(
    skus: PricerSku[],
    config: PricingConfig,
    pricePointsMap: Map<number, PricePoint> = new Map(),
    source: string = "pricing",
    productDisplayMap?: Map<number, ProductDisplayInfo>
  ): Promise<PricingCalculationResult> {
    const startTime = Date.now();
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    let warnings = 0;

    const pricedItems: PricingResult[] = [];
    const allPercentileData: Array<{
      percentile: number;
      price: number;
      historicalSalesVelocityMs?: number; // Historical sales intervals (sales velocity only)
      estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
      quantity: number;
    }> = [];

    // Initialize progress
    config.onProgress?.({
      current: 0,
      total: skus.length,
      status: `Starting to process ${skus.length} SKUs...`,
      processed: 0,
      skipped: 0,
      errors: 0,
      warnings: 0,
    });

    // Process each SKU
    for (let i = 0; i < skus.length && !config.isCancelled?.(); i++) {
      const pricerSku = skus[i];

      // Get display name if available
      const productInfo = productDisplayMap?.get(pricerSku.sku);
      const displayName = productInfo?.productName
        ? `${productInfo.productName} (${pricerSku.sku})`
        : `SKU ${pricerSku.sku}`;

      // Update progress
      config.onProgress?.({
        current: i + 1,
        total: skus.length,
        status: `Processing ${i + 1}/${skus.length}: ${displayName}...`,
        processed,
        skipped,
        errors,
        warnings,
      });

      try {
        // Skip invalid SKUs
        if (!pricerSku.sku || pricerSku.sku <= 0) {
          skipped++;
          continue;
        }

        // Get suggested price for this SKU
        const result = await getSuggestedPrice(
          pricerSku.sku.toString(),
          config.percentile,
          config.enableSupplyAnalysis,
          config.supplyAnalysisConfig
        );

        // Create pricing result from suggested price result
        const pricedItem = await this.createPricedItem(
          pricerSku,
          result,
          pricePointsMap
        );

        // Track errors vs warnings vs success
        if (pricedItem.errors && pricedItem.errors.length > 0) {
          errors++;
        } else if (pricedItem.warnings && pricedItem.warnings.length > 0) {
          warnings++;
          processed++; // Items with warnings are still successfully processed
        } else {
          processed++;
        }

        // Collect percentile data for aggregation if available
        // Include all SKUs that have percentile data, regardless of errors
        if (result.percentiles && Array.isArray(result.percentiles)) {
          const quantity =
            (pricerSku.quantity || 0) + (pricerSku.addToQuantity || 0);
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

        pricedItems.push(pricedItem);
      } catch (error: any) {
        const errorItem: PricingResult = {
          sku: pricerSku.sku,
          quantity: pricerSku.quantity,
          addToQuantity: pricerSku.addToQuantity,
          previousPrice: pricerSku.currentPrice,
          errors: [error?.message || "Processing error"],
        };
        pricedItems.push(errorItem);
        errors++;
      }
    }

    // Check if cancelled
    if (config.isCancelled?.()) {
      throw new Error("Processing cancelled by user");
    }

    // Final progress update
    config.onProgress?.({
      current: skus.length,
      total: skus.length,
      status: "Pricing calculation complete!",
      processed,
      skipped,
      errors,
      warnings,
    });

    const processingTime = Date.now() - startTime;

    // Calculate aggregated percentiles
    const aggregatedPercentiles =
      this.calculateAggregatedPercentiles(allPercentileData);

    return {
      pricedItems,
      stats: {
        processed,
        skipped,
        errors,
        warnings,
        processingTime,
      },
      aggregatedPercentiles,
    };
  }

  private calculateAggregatedPercentiles(
    percentileData: Array<{
      percentile: number;
      price: number;
      historicalSalesVelocityMs?: number; // Historical sales intervals (sales velocity only)
      estimatedTimeToSellMs?: number; // Market-adjusted time (velocity + current competition)
      salesCount?: number; // Number of sales used for historical calculation
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

    // Calculate TOTAL VALUES for each percentile (not averages)
    // This represents the total value if all inventory was priced at this percentile
    Object.entries(percentileGroups).forEach(([percentile, items]) => {
      let totalValue = 0;
      let totalQuantity = 0;

      items.forEach((item) => {
        const quantity = item.quantity || 1;
        // Calculate total value: price * quantity for each SKU at this percentile
        totalValue += item.price * quantity;
        totalQuantity += quantity;
      });

      // Store total value (not average price)
      aggregated.marketPrice[`${percentile}th`] = totalValue;

      if (totalQuantity > 0) {
        // Calculate median historical sales velocity
        const historicalVelocityValues = items
          .map((item) => {
            const timeMs = item.historicalSalesVelocityMs;
            return timeMs ? timeMs / (24 * 60 * 60 * 1000) : undefined; // Convert ms to days
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

        // Calculate median market-adjusted time to sell (if available)
        const marketAdjustedValues = items
          .map((item) => {
            const timeMs = item.estimatedTimeToSellMs;
            return timeMs ? timeMs / (24 * 60 * 60 * 1000) : undefined; // Convert ms to days
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

  private async createPricedItem(
    pricerSku: PricerSku,
    result: any,
    pricePointsMap: Map<number, PricePoint> = new Map()
  ): Promise<PricingResult> {
    const pricedItem: PricingResult = {
      sku: pricerSku.sku,
      quantity: pricerSku.quantity,
      addToQuantity: pricerSku.addToQuantity,
      previousPrice: pricerSku.currentPrice,
      errors: [],
      warnings: [],
    };

    // Handle errors
    if (result.error) {
      pricedItem.errors?.push(result.error);
      return pricedItem;
    }

    // Set pricing data with minimum price bounds
    if (result.suggestedPrice !== null && result.suggestedPrice !== undefined) {
      // Always set the original suggested price from the algorithm
      pricedItem.suggestedPrice = result.suggestedPrice;

      // Get price point from the provided map (no API call needed)
      const pricePoint = pricePointsMap.get(pricerSku.sku) || null;

      // Apply minimum price bounds
      const { marketplacePrice, warningMessage, errorMessage } =
        calculateMarketplacePrice(
          result.suggestedPrice,
          pricePoint
            ? {
                marketPrice: pricePoint.marketPrice,
                lowestPrice: pricePoint.lowestPrice,
                highestPrice: pricePoint.highestPrice,
                calculatedAt: pricePoint.calculatedAt,
              }
            : null
        );

      // Set the bounded price as the marketplace price
      pricedItem.price = marketplacePrice;

      // Add warning message if minimum price was applied (this is just a warning, not an error)
      if (warningMessage) {
        pricedItem.warnings?.push(warningMessage);
      }

      // Add error message for actual pricing failures
      if (errorMessage) {
        pricedItem.errors?.push(errorMessage);
      }
    }

    // Add time to sell data (convert from milliseconds to days)
    if (result.historicalSalesVelocityMs) {
      pricedItem.historicalSalesVelocityDays =
        result.historicalSalesVelocityMs / (24 * 60 * 60 * 1000);
    }

    if (result.estimatedTimeToSellMs) {
      pricedItem.estimatedTimeToSellDays =
        result.estimatedTimeToSellMs / (24 * 60 * 60 * 1000);
    }

    // Add sales count for historical calculation
    if (result.salesCount !== undefined) {
      pricedItem.salesCountForHistorical = result.salesCount;
    }

    return pricedItem;
  }
}
