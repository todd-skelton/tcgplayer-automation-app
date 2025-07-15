import type {
  TcgPlayerListing,
  ProcessingProgress,
  ProcessingSummary,
  SuggestedPriceResult,
} from "../types/pricing";
import {
  PRICING_CONSTANTS,
  PERCENTILES,
  FILE_CONFIG,
} from "../constants/pricing";
import {
  calculateMedian,
  shouldSkipRow,
  initializeRowColumns,
  getRowQuantities,
  downloadCSV,
} from "../utils/csvProcessing";
import { getSuggestedPrice } from "./pricingService";

interface PricePointsResponse {
  pricePoints: Array<{
    skuId: number;
    marketPrice: number;
    lowestPrice: number;
    highestPrice: number;
    priceCount: number;
    calculatedAt: string;
  }>;
  totalSkus: number;
  foundPrices: number;
  error?: string;
}

export interface ProcessingConfig {
  percentile: number;
  onProgress?: (progress: ProcessingProgress) => void;
  onError?: (error: string) => void;
  isCancelled?: () => boolean;
}

interface PricePointData {
  marketPrice: number;
  lowestPrice: number;
  highestPrice: number;
  saleCount: number;
  calculatedAt: string;
}

interface SummaryData {
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
  daysToSellValues: number[];
  percentileDaysValues: { [key: string]: number[] };
}

export class ListingProcessor {
  private pricePointCache: Map<number, PricePointData> = new Map();

  private async fetchMarketPrices(skuIds: number[]): Promise<void> {
    try {
      const response = await fetch("/api/price-points", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ skuIds }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PricePointsResponse = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      data.pricePoints.forEach((pricePoint) => {
        this.pricePointCache.set(pricePoint.skuId, {
          marketPrice: pricePoint.marketPrice,
          lowestPrice: pricePoint.lowestPrice,
          highestPrice: pricePoint.highestPrice,
          saleCount: pricePoint.priceCount,
          calculatedAt: pricePoint.calculatedAt,
        });
      });
    } catch (error) {
      console.warn("Failed to fetch market prices:", error);
      // Continue processing without market prices if the API fails
    }
  }

  private getPricePointData(skuId: number): PricePointData | null {
    return this.pricePointCache.get(skuId) || null;
  }

  private initializeSummaryData(percentile: number): SummaryData {
    const summaryData: SummaryData = {
      totalQuantity: 0,
      totalAddQuantity: 0,
      totals: {
        marketPrice: 0,
        lowPrice: 0,
        marketplacePrice: 0,
        percentiles: {},
      },
      totalsWithMarket: {
        marketPrice: 0,
        percentiles: {},
        quantityWithMarket: 0,
      },
      daysToSellValues: [],
      percentileDaysValues: {},
    };

    // Initialize percentile tracking for standard percentiles (0, 10, 20, ... 100)
    PERCENTILES.forEach((p) => {
      summaryData.totals.percentiles[`${p}th`] = 0;
      summaryData.totalsWithMarket.percentiles[`${p}th`] = 0;
      summaryData.percentileDaysValues[`${p}th`] = [];
    });

    // Add the selected percentile if it's not already in the standard percentiles
    if (!PERCENTILES.includes(percentile)) {
      summaryData.totals.percentiles[`${percentile}th`] = 0;
      summaryData.totalsWithMarket.percentiles[`${percentile}th`] = 0;
      summaryData.percentileDaysValues[`${percentile}th`] = [];
    }

    return summaryData;
  }

  private addErrorMessage(row: TcgPlayerListing, message: string): void {
    const existingError = row["Error"] || "";
    row["Error"] = existingError ? `${existingError}; ${message}` : message;
  }

  private updateMarketplacePrice(
    row: TcgPlayerListing,
    suggestedPrice: number
  ): void {
    // Validate suggested price
    if (
      suggestedPrice === null ||
      suggestedPrice === undefined ||
      isNaN(suggestedPrice)
    ) {
      this.addErrorMessage(row, "Invalid suggested price value");
      return;
    }

    const skuId = Number(row["TCGplayer Id"]);
    const pricePointData = this.getPricePointData(skuId);
    const marketPrice = pricePointData?.marketPrice || 0;

    // Case 1: No market price available - use suggested price without enforcement
    if (marketPrice === 0) {
      row["TCG Marketplace Price"] = suggestedPrice.toString();
      this.addErrorMessage(
        row,
        "No market price available. Using suggested price directly."
      );
      return;
    }

    // Case 2: Market price available - enforce lower bound only
    const lowerBound =
      marketPrice * PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER -
      PRICING_CONSTANTS.MIN_PRICE_CONSTANT;

    if (suggestedPrice < lowerBound) {
      row["TCG Marketplace Price"] = lowerBound.toFixed(2);
      this.addErrorMessage(
        row,
        "Suggested price below minimum. Using minimum price."
      );
    } else {
      row["TCG Marketplace Price"] = suggestedPrice.toString();
    }
  }

  private determineSuggestedPrice(
    row: TcgPlayerListing,
    result: SuggestedPriceResult
  ): { price: number | null; success: boolean } {
    // Try suggested price first
    if (
      result.suggestedPrice !== null &&
      result.suggestedPrice !== undefined &&
      !isNaN(result.suggestedPrice)
    ) {
      return { price: result.suggestedPrice, success: true };
    }

    // Fallback to TCG Low Price
    const lowPrice = Number(row["TCG Low Price"]) || 0;
    if (lowPrice > 0) {
      this.addErrorMessage(
        row,
        "No suggested price available. Using TCG Low Price as fallback."
      );
      return { price: lowPrice, success: true };
    }

    // Fallback to current marketplace price
    const currentPrice = Number(row["TCG Marketplace Price"]) || 0;
    if (currentPrice > 0) {
      this.addErrorMessage(
        row,
        "No suggested or low price available. Retaining current marketplace price."
      );
      return { price: currentPrice, success: true };
    }

    // No valid price found
    this.addErrorMessage(
      row,
      "No suggested price, low price, or current marketplace price available"
    );
    return { price: null, success: false };
  }

  private updateRowWithResults(
    row: TcgPlayerListing,
    result: SuggestedPriceResult,
    summaryData: SummaryData,
    percentile: number
  ): { success: boolean } {
    if (result.error) {
      row["Error"] = result.error;
      return { success: false };
    }

    // Determine the suggested price using fallback hierarchy
    const { price: suggestedPrice, success: priceSuccess } =
      this.determineSuggestedPrice(row, result);

    if (!priceSuccess || suggestedPrice === null) {
      return { success: false };
    }

    // Safely convert suggestedPrice to string
    try {
      row["Suggested Price"] = suggestedPrice.toString();
    } catch (error) {
      this.addErrorMessage(row, "Invalid suggested price value");
      return { success: false };
    }

    // Update marketplace price
    this.updateMarketplacePrice(row, suggestedPrice);

    // Get all price point data for this SKU in one lookup
    const skuId = Number(row["TCGplayer Id"]);
    const pricePointData = this.getPricePointData(skuId);

    if (pricePointData) {
      // Update all price fields when price data is available
      if (pricePointData.marketPrice > 0) {
        row["TCG Market Price"] = pricePointData.marketPrice.toFixed(2);
      }

      if (pricePointData.lowestPrice > 0) {
        row["TCG Low Price"] = pricePointData.lowestPrice.toFixed(2);
        row["Lowest Price"] = pricePointData.lowestPrice.toFixed(2);
      }

      if (pricePointData.highestPrice > 0) {
        row["Highest Price"] = pricePointData.highestPrice.toFixed(2);
      }

      if (pricePointData.saleCount > 0) {
        row["Sale Count"] = pricePointData.saleCount.toString();
      }
    }

    // Update summary data
    const { totalQty, addQty, combinedQty } = getRowQuantities(row);
    const lowPrice = Number(row["TCG Low Price"]) || 0;
    const marketplacePrice = Number(row["TCG Marketplace Price"]) || 0;
    const marketPrice = pricePointData?.marketPrice || 0;

    summaryData.totals.marketPrice += marketPrice * combinedQty;
    summaryData.totals.lowPrice += lowPrice * combinedQty;
    summaryData.totals.marketplacePrice += marketplacePrice * combinedQty;

    if (marketPrice > 0) {
      summaryData.totalsWithMarket.marketPrice += marketPrice * combinedQty;
      summaryData.totalsWithMarket.quantityWithMarket += combinedQty;
    }

    // Track days to sell for summary analytics and add to CSV output
    const daysToSell = result.expectedTimeToSellDays || 0;
    if (daysToSell > 0) {
      summaryData.daysToSellValues.push(daysToSell);
      row["Expected Days to Sell"] = daysToSell.toString();
    }

    // Process percentile data for summary analytics
    if (result.percentiles && result.percentiles.length > 0) {
      result.percentiles.forEach((percentileData: any) => {
        if (percentileData && typeof percentileData.price === "number") {
          const percentileKey = `${percentileData.percentile}th`;

          // Track price data for summary
          if (summaryData.totals.percentiles[percentileKey] !== undefined) {
            summaryData.totals.percentiles[percentileKey] +=
              percentileData.price * combinedQty;
            summaryData.totalsWithMarket.percentiles[percentileKey] +=
              percentileData.price * combinedQty;
          }

          // Track days data for summary
          if (
            percentileData.expectedTimeToSellDays &&
            percentileData.expectedTimeToSellDays > 0
          ) {
            if (summaryData.percentileDaysValues[percentileKey]) {
              summaryData.percentileDaysValues[percentileKey].push(
                percentileData.expectedTimeToSellDays
              );
            }
          }
        }
      });
    } else {
      // Fallback: use suggested price for all percentiles if no percentile data available
      PERCENTILES.forEach((p) => {
        summaryData.totals.percentiles[`${p}th`] +=
          suggestedPrice * combinedQty;
        summaryData.totalsWithMarket.percentiles[`${p}th`] +=
          suggestedPrice * combinedQty;

        if (daysToSell > 0) {
          summaryData.percentileDaysValues[`${p}th`].push(daysToSell);
        }
      });

      // Also process the selected percentile if it's not in the standard percentiles
      if (!PERCENTILES.includes(percentile)) {
        summaryData.totals.percentiles[`${percentile}th`] +=
          suggestedPrice * combinedQty;
        summaryData.totalsWithMarket.percentiles[`${percentile}th`] +=
          suggestedPrice * combinedQty;

        if (daysToSell > 0) {
          summaryData.percentileDaysValues[`${percentile}th`].push(daysToSell);
        }
      }
    }

    return { success: true };
  }

  private createProcessingSummary(
    source: string,
    percentile: number,
    totalRows: number,
    processed: number,
    skipped: number,
    errors: number,
    summaryData: SummaryData,
    processingTime: number
  ): ProcessingSummary {
    // Calculate medians for days to sell
    const medianDaysToSell = {
      expectedDaysToSell: calculateMedian(summaryData.daysToSellValues),
      percentiles: {} as { [key: string]: number },
    };

    PERCENTILES.forEach((p) => {
      medianDaysToSell.percentiles[`${p}th`] = calculateMedian(
        summaryData.percentileDaysValues[`${p}th`]
      );
    });

    // Also calculate median for the selected percentile if it's not in the standard percentiles
    if (!PERCENTILES.includes(percentile)) {
      medianDaysToSell.percentiles[`${percentile}th`] = calculateMedian(
        summaryData.percentileDaysValues[`${percentile}th`]
      );
    }

    const totalProcessed = processed + errors;
    const successRate =
      totalProcessed > 0 ? (processed / totalProcessed) * 100 : 0;

    return {
      totalRows,
      processedRows: processed,
      skippedRows: skipped,
      errorRows: errors,
      successRate,
      processingTime,
      fileName: source,
      percentileUsed: percentile,
      totalQuantity: summaryData.totalQuantity,
      totalAddQuantity: summaryData.totalAddQuantity,
      totals: summaryData.totals,
      totalsWithMarket: summaryData.totalsWithMarket,
      medianDaysToSell,
    };
  }

  async processListings(
    listings: TcgPlayerListing[],
    config: ProcessingConfig,
    source: string = "listings"
  ): Promise<{
    processedListings: TcgPlayerListing[];
    summary: ProcessingSummary;
  }> {
    const startTime = Date.now();
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    const summaryData = this.initializeSummaryData(config.percentile);

    // Initialize new columns for all rows first
    listings.forEach((row) => {
      initializeRowColumns(row);
    });

    // Filter out rows that should be skipped before processing
    const filteredRows = listings.filter((row) => {
      if (shouldSkipRow(row)) {
        skipped++;
        return false;
      }

      // Track quantities for summary
      const { totalQty, addQty } = getRowQuantities(row);
      summaryData.totalQuantity += totalQty;
      summaryData.totalAddQuantity += addQty;

      return true;
    });

    // Check for and remove duplicate SKU IDs
    const seenSkuIds = new Set<string>();
    const deduplicatedRows: TcgPlayerListing[] = [];
    let duplicatesRemoved = 0;

    filteredRows.forEach((row) => {
      const skuId = row["TCGplayer Id"];
      if (seenSkuIds.has(skuId)) {
        console.warn(`Duplicate SKU ID found: ${skuId}. Skipping duplicate.`);
        duplicatesRemoved++;
        return;
      }
      seenSkuIds.add(skuId);
      deduplicatedRows.push(row);
    });

    if (duplicatesRemoved > 0) {
      config.onProgress?.({
        current: 0,
        total: deduplicatedRows.length,
        status: `Removed ${duplicatesRemoved} duplicate SKU ID${
          duplicatesRemoved > 1 ? "s" : ""
        }. Processing ${deduplicatedRows.length} unique items...`,
        processed: 0,
        skipped: skipped + duplicatesRemoved,
        errors: 0,
      });
    }

    // Fetch market prices for all SKUs before processing
    config.onProgress?.({
      current: 0,
      total: deduplicatedRows.length,
      status: "Fetching market prices for SKUs...",
      processed: 0,
      skipped: skipped + duplicatesRemoved,
      errors: 0,
    });

    const skuIds = deduplicatedRows
      .map((row) => Number(row["TCGplayer Id"]))
      .filter((skuId) => !isNaN(skuId) && skuId > 0);

    if (skuIds.length > 0) {
      await this.fetchMarketPrices(skuIds);
    }

    // Initialize progress
    config.onProgress?.({
      current: 0,
      total: deduplicatedRows.length,
      status: `Starting to process ${deduplicatedRows.length} rows (${
        skipped + duplicatesRemoved
      } skipped)...`,
      processed: 0,
      skipped: skipped + duplicatesRemoved,
      errors: 0,
    });

    // Process deduplicated rows serially (one at a time)
    for (
      let rowIndex = 0;
      rowIndex < deduplicatedRows.length && !config.isCancelled?.();
      rowIndex++
    ) {
      const row = deduplicatedRows[rowIndex];

      // Update progress before processing
      config.onProgress?.({
        current: rowIndex + 1,
        total: deduplicatedRows.length,
        status: `Processing row ${rowIndex + 1}/${deduplicatedRows.length} (${
          row["Product Name"]
        })...`,
        processed,
        skipped: skipped + duplicatesRemoved,
        errors,
      });

      try {
        const result = await getSuggestedPrice(
          row["TCGplayer Id"],
          config.percentile
        );
        const { success } = this.updateRowWithResults(
          row,
          result,
          summaryData,
          config.percentile
        );

        if (success) {
          processed++;
        } else {
          errors++;
        }
      } catch (error: any) {
        row["Error"] = error?.message || "Processing error";
        errors++;
      }
    }

    // Check if cancelled before final steps
    if (config.isCancelled?.()) {
      throw new Error("Processing cancelled by user");
    }

    // Final progress update
    config.onProgress?.({
      current: deduplicatedRows.length,
      total: deduplicatedRows.length,
      status: "Processing complete!",
      processed,
      skipped: skipped + duplicatesRemoved,
      errors,
    });

    // Create comprehensive summary
    const processingTime = Date.now() - startTime;
    const summary = this.createProcessingSummary(
      source,
      config.percentile,
      listings.length,
      processed,
      skipped + duplicatesRemoved,
      errors,
      summaryData,
      processingTime
    );

    return {
      processedListings: deduplicatedRows,
      summary,
    };
  }

  downloadProcessedListings(
    listings: TcgPlayerListing[],
    filename?: string
  ): void {
    const defaultFilename = `${FILE_CONFIG.OUTPUT_PREFIX}${Date.now()}.csv`;
    downloadCSV(listings, filename || defaultFilename);
  }
}
