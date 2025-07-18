import type { PricerSku, PricingConfig } from "../types/pricing";
import { getSuggestedPrice } from "./pricingService";
import { calculateMarketplacePrice } from "./pricingService";
import type { PricePoint } from "../tcgplayer/get-price-points";

export interface PricingResult {
  sku: number;
  quantity?: number;
  addToQuantity?: number;
  previousPrice?: number;
  suggestedPrice?: number;
  price?: number;
  expectedDaysToSell?: number;
  errors?: string[];
}

export interface PricingCalculationResult {
  pricedItems: PricingResult[];
  stats: {
    processed: number;
    skipped: number;
    errors: number;
    processingTime: number;
  };
  aggregatedPercentiles: {
    marketPrice: { [key: string]: number };
    expectedDaysToSell: { [key: string]: number };
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
    source: string = "pricing"
  ): Promise<PricingCalculationResult> {
    const startTime = Date.now();
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    const pricedItems: PricingResult[] = [];
    const allPercentileData: Array<{
      percentile: number;
      price: number;
      expectedTimeToSellDays?: number;
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
    });

    // Process each SKU
    for (let i = 0; i < skus.length && !config.isCancelled?.(); i++) {
      const pricerSku = skus[i];

      // Update progress
      config.onProgress?.({
        current: i + 1,
        total: skus.length,
        status: `Processing SKU ${i + 1}/${skus.length} (${pricerSku.sku})...`,
        processed,
        skipped,
        errors,
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
          config.percentile
        );

        // Create pricing result from suggested price result
        const pricedItem = await this.createPricedItem(
          pricerSku,
          result,
          pricePointsMap
        );

        if (pricedItem.errors && pricedItem.errors.length > 0) {
          errors++;
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
              expectedTimeToSellDays: p.expectedTimeToSellDays,
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
        processingTime,
      },
      aggregatedPercentiles,
    };
  }

  private calculateAggregatedPercentiles(
    percentileData: Array<{
      percentile: number;
      price: number;
      expectedTimeToSellDays?: number;
      quantity: number;
    }>
  ): {
    marketPrice: { [key: string]: number };
    expectedDaysToSell: { [key: string]: number };
  } {
    const aggregated = {
      marketPrice: {} as { [key: string]: number },
      expectedDaysToSell: {} as { [key: string]: number },
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
      let totalWeightedDays = 0;
      let totalQuantity = 0;

      items.forEach((item) => {
        const quantity = item.quantity || 1;
        // Calculate total value: price * quantity for each SKU at this percentile
        totalValue += item.price * quantity;
        totalQuantity += quantity;

        if (item.expectedTimeToSellDays !== undefined) {
          totalWeightedDays += item.expectedTimeToSellDays * quantity;
        }
      });

      // Store total value (not average price)
      aggregated.marketPrice[`${percentile}th`] = totalValue;

      if (totalQuantity > 0) {
        aggregated.expectedDaysToSell[`${percentile}th`] =
          totalWeightedDays / totalQuantity;
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
      const { marketplacePrice, errorMessage } = calculateMarketplacePrice(
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

      // Add error message if minimum price was applied
      if (errorMessage) {
        pricedItem.errors?.push(errorMessage);
      }
    }

    if (result.expectedTimeToSellDays) {
      pricedItem.expectedDaysToSell = result.expectedTimeToSellDays;
    }

    return pricedItem;
  }
}
