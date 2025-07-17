import type {
  PricerSku,
  PricingConfig,
  ProcessingProgress,
} from "../types/pricing";
import { getSuggestedPrice } from "./pricingService";
import {
  calculateMarketplacePrice,
  type PricePointData,
} from "./pricingService";
import { getPricePoints } from "../tcgplayer/get-price-points";

export interface PricedPricing {
  sku: number;
  quantity?: number;
  addToQuantity?: number;
  previousPrice?: number;
  suggestedPrice?: number;
  price?: number;
  expectedDaysToSell?: number;
  errors?: string[];
}

export interface PurePricingResult {
  pricedItems: PricedPricing[];
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
 * Pure pricing service that only handles price calculation.
 * No data enrichment, no file operations, no UI concerns.
 */
export class PurePricingService {
  async calculatePrices(
    skus: PricerSku[],
    config: PricingConfig,
    source: string = "pricing"
  ): Promise<PurePricingResult> {
    const startTime = Date.now();
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    const pricedItems: PricedPricing[] = [];
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

        // Create PricedPricing from result
        const pricedItem = await this.createPricedItem(pricerSku, result);

        if (pricedItem.errors && pricedItem.errors.length > 0) {
          errors++;
        } else {
          processed++;

          // Collect percentile data for aggregation if available
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
        }

        pricedItems.push(pricedItem);
      } catch (error: any) {
        const errorItem: PricedPricing = {
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

    // Debug logging to understand the percentile issue
    console.log("=== PERCENTILE DEBUG INFO ===");
    console.log("Total SKUs processed:", processed);
    console.log("All percentile data entries:", allPercentileData.length);
    console.log(
      "Sample percentile data (first 5):",
      allPercentileData.slice(0, 5)
    );
    console.log(
      "Aggregated percentile TOTAL VALUES:",
      aggregatedPercentiles.marketPrice
    );
    console.log("Sample percentile breakdown for first SKU:");
    if (allPercentileData.length > 0) {
      const firstSku = allPercentileData[0];
      const relatedPercentiles = allPercentileData.filter(
        (p) =>
          p.quantity === firstSku.quantity && allPercentileData.indexOf(p) < 11 // First 11 percentiles (0-100th)
      );
      console.log("Percentiles for first SKU:", relatedPercentiles);
    }
    console.log(
      "Sample priced items (first 2):",
      pricedItems.slice(0, 2).map((item) => ({
        sku: item.sku,
        quantity: item.quantity,
        addToQuantity: item.addToQuantity,
        suggestedPrice: item.suggestedPrice,
      }))
    );
    console.log("==============================");

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
    result: any
  ): Promise<PricedPricing> {
    const pricedItem: PricedPricing = {
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

      try {
        // Get price points for market price data to apply bounds
        const pricePoints = await getPricePoints({ skuIds: [pricerSku.sku] });
        const pricePoint = pricePoints.length > 0 ? pricePoints[0] : null;

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
      } catch (pricePointError) {
        // If we can't get price points, use the original suggested price as marketplace price
        console.warn(
          `Could not get price points for SKU ${pricerSku.sku}:`,
          pricePointError
        );
        pricedItem.price = result.suggestedPrice;
      }
    }

    if (result.expectedTimeToSellDays) {
      pricedItem.expectedDaysToSell = result.expectedTimeToSellDays;
    }

    return pricedItem;
  }
}
