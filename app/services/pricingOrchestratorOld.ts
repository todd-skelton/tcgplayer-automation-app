import type {
  PricedSku,
  PricingConfig,
  ProcessingSummary,
} from "../types/pricing";
import type { DataSourceService } from "./dataSourceInterfaces";
import { PricingCalculator } from "./pricingCalculator";
import { DataEnrichmentService } from "./dataEnrichmentService";
import { PricedSkuToTcgPlayerListingConverter } from "./dataConverters";
import { SupplyAnalysisService } from "./supplyAnalysisService";
import { downloadCSV } from "../utils/csvProcessing";
import type { PurePricingConfig } from "../types/pricingData";

export interface PipelineResult {
  pricedSkus: PricedSku[];
  summary: ProcessingSummary;
  exportInfo?: {
    mainFile: string;
    manualReviewFile?: string;
    successfulCount: number;
    failedCount: number;
  };
}

export interface PipelineConfig extends PricingConfig {
  source: string;
  enableEnrichment?: boolean;
  enableExport?: boolean;
  filename?: string;
  enableSupplyAnalysis?: boolean; // Override for pipeline-specific supply analysis
}

/**
 * Orchestrates the complete pricing pipeline with proper separation of concerns
 */
export class PricingOrchestrator {
  private pricingCalculator = new PricingCalculator();
  private enrichmentService = new DataEnrichmentService();
  private outputConverter = new PricedSkuToTcgPlayerListingConverter();
  private supplyAnalysisService = new SupplyAnalysisService();

  /**
   * Execute the complete pricing pipeline using the new pure data approach
   */
  async executePurePipeline<TInput>(
    dataSource: DataSourceService<TInput>,
    sourceParams: any,
    config: PipelineConfig
  ): Promise<PipelineResult> {
    // If running in browser or services not available, fall back to original pipeline
    if (!this.dataGatheringService || !this.purePricingService) {
      return this.executePipeline(dataSource, sourceParams, config);
    }

    const startTime = Date.now();

    try {
      // Step 1: Source and validate data (unchanged)
      config.onProgress?.({
        current: 0,
        total: 0,
        status: "Fetching and validating data...",
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      });

      const rawData = await dataSource.fetchData(sourceParams);
      if (config.isCancelled?.()) throw new Error("Processing cancelled by user");

      const validatedData = await dataSource.validateData(rawData);
      if (config.isCancelled?.()) throw new Error("Processing cancelled by user");

      const pricerSkus = await dataSource.convertToPricerSku(validatedData);
      if (config.isCancelled?.()) throw new Error("Processing cancelled by user");

      // Step 2: Gather ALL data upfront
      config.onProgress?.({
        current: 0,
        total: pricerSkus.length,
        status: "Gathering all pricing data...",
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      });

      const pureConfig: PurePricingConfig = {
        percentile: config.percentile,
        halfLifeDays: config.halfLifeDays,
        enableSupplyAnalysis: config.enableSupplyAnalysis || false,
        supplyAnalysisConfig: config.supplyAnalysisConfig,
      };

      const batchData = await this.dataGatheringService.gatherBatchData(
        pricerSkus,
        pureConfig,
        (current, total, status) => {
          config.onProgress?.({
            current,
            total,
            status,
            processed: 0,
            skipped: 0,
            errors: 0,
            warnings: 0,
          });
        }
      );

      if (config.isCancelled?.()) throw new Error("Processing cancelled by user");

      // Step 3: Execute pure pricing (no external dependencies)
      config.onProgress?.({
        current: 0,
        total: pricerSkus.length,
        status: "Calculating prices...",
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      });

      const pricingResult = this.purePricingService.calculateBatchPrices(batchData);

      if (config.isCancelled?.()) throw new Error("Processing cancelled by user");

      // Step 4: Convert to display format and enrich (if needed)
      config.onProgress?.({
        current: 0,
        total: pricingResult.results.length,
        status: "Preparing results...",
        processed: pricingResult.stats.processed,
        skipped: pricingResult.stats.skipped,
        errors: pricingResult.stats.errors,
        warnings: pricingResult.stats.warnings,
      });

      // Convert pure results to PricedSku format
      const finalPricedSkus: PricedSku[] = pricingResult.results.map((result, index) => {
        const skuData = batchData.skusData[index];
        return {
          sku: result.sku,
          quantity: skuData.sku.quantity,
          addToQuantity: skuData.sku.addToQuantity,
          previousPrice: skuData.sku.currentPrice,
          suggestedPrice: result.suggestedPrice,
          price: result.price,
          historicalSalesVelocityDays: result.historicalSalesVelocityMs
            ? result.historicalSalesVelocityMs / (24 * 60 * 60 * 1000)
            : undefined,
          estimatedTimeToSellDays: result.estimatedTimeToSellMs
            ? result.estimatedTimeToSellMs / (24 * 60 * 60 * 1000)
            : undefined,
          salesCountForHistorical: result.salesCount,
          listingsCountForEstimated: result.listingsCount,
          errors: result.errors,
          warnings: result.warnings,
          // Add product info from gathered data
          productLine: skuData.productInfo?.productLine,
          setName: skuData.productInfo?.setName,
          productName: skuData.productInfo?.productName,
          condition: skuData.productInfo?.condition,
          variant: skuData.productInfo?.variant,
          // Add market data from price points
          lowestSalePrice: skuData.pricePoint?.lowestPrice,
          highestSalePrice: skuData.pricePoint?.highestPrice,
          saleCount: skuData.pricePoint?.priceCount,
          tcgMarketPrice: skuData.pricePoint?.marketPrice,
        };
      });

      if (config.isCancelled?.()) throw new Error("Processing cancelled by user");

      // Step 5: Export results (unchanged)
      let exportInfo: PipelineResult["exportInfo"];
      if (config.enableExport !== false) {
        config.onProgress?.({
          current: finalPricedSkus.length,
          total: finalPricedSkus.length,
          status: "Preparing export...",
          processed: pricingResult.stats.processed,
          skipped: pricingResult.stats.skipped,
          errors: pricingResult.stats.errors,
          warnings: pricingResult.stats.warnings,
        });

        const successfullyPriced = finalPricedSkus.filter(
          (sku) =>
            sku.price !== undefined &&
            sku.price !== null &&
            sku.price > 0 &&
            (!sku.errors || sku.errors.length === 0)
        );
        const failedPricing = finalPricedSkus.filter(
          (sku) =>
            sku.price === undefined ||
            sku.price === null ||
            sku.price <= 0 ||
            (sku.errors && sku.errors.length > 0)
        );

        // Sort and export files (same logic as before)
        const sortedSuccessfullyPriced = [...successfullyPriced].sort((a, b) => {
          const productLineA = a.productLine || "";
          const productLineB = b.productLine || "";
          if (productLineA !== productLineB) {
            return productLineA.localeCompare(productLineB);
          }
          const setNameA = a.setName || "";
          const setNameB = b.setName || "";
          if (setNameA !== setNameB) {
            return setNameA.localeCompare(setNameB);
          }
          const productNameA = a.productName || "";
          const productNameB = b.productName || "";
          return productNameA.localeCompare(productNameB);
        });

        const csvData = this.outputConverter.convertFromPricedSkus(sortedSuccessfullyPriced);
        const filename = config.filename || `priced-${config.source}-${Date.now()}.csv`;
        downloadCSV(csvData, filename);

        let manualReviewFile: string | undefined;
        if (failedPricing.length > 0) {
          const sortedFailedPricing = [...failedPricing].sort((a, b) => {
            const productLineA = a.productLine || "";
            const productLineB = b.productLine || "";
            if (productLineA !== productLineB) {
              return productLineA.localeCompare(productLineB);
            }
            const setNameA = a.setName || "";
            const setNameB = b.setName || "";
            if (setNameA !== setNameB) {
              return setNameA.localeCompare(setNameB);
            }
            const productNameA = a.productName || "";
            const productNameB = b.productName || "";
            return productNameA.localeCompare(productNameB);
          });

          const failedCsvData = this.outputConverter.convertFromPricedSkus(sortedFailedPricing);
          manualReviewFile = config.filename
            ? config.filename.replace(".csv", "-manual-review.csv")
            : `priced-${config.source}-${Date.now()}-manual-review.csv`;
          downloadCSV(failedCsvData, manualReviewFile);
        }

        exportInfo = {
          mainFile: filename,
          manualReviewFile,
          successfulCount: sortedSuccessfullyPriced.length,
          failedCount: failedPricing.length,
        };
      }

      // Create summary
      const totalProcessingTime = Date.now() - startTime;
      const summary = this.createProcessingSummary(
        config.source,
        config.percentile,
        rawData.length,
        pricingResult.stats,
        finalPricedSkus,
        totalProcessingTime,
        pricingResult.aggregatedPercentiles
      );

      return {
        pricedSkus: finalPricedSkus,
        summary,
        exportInfo,
      };
    } catch (error: any) {
      if (error.message === "Processing cancelled by user") {
        throw error;
      }
      config.onError?.(error?.message || "Pipeline execution failed");
      throw error;
    }
  }

  /**
   * Execute the complete pricing pipeline
   */
  async executePipeline<TInput>(
    dataSource: DataSourceService<TInput>,
    sourceParams: any,
    config: PipelineConfig
  ): Promise<PipelineResult> {
    const startTime = Date.now();

    try {
      // Step 1: Source data
      config.onProgress?.({
        current: 0,
        total: 0,
        status: "Fetching data...",
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      });

      const rawData = await dataSource.fetchData(sourceParams);

      if (config.isCancelled?.()) {
        throw new Error("Processing cancelled by user");
      }

      // Step 2: Validate data
      config.onProgress?.({
        current: 0,
        total: rawData.length,
        status: "Validating data...",
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      });

      const validatedData = await dataSource.validateData(rawData);

      if (config.isCancelled?.()) {
        throw new Error("Processing cancelled by user");
      }

      // Step 3: Convert to pricing format
      config.onProgress?.({
        current: 0,
        total: validatedData.length,
        status: "Converting to pricing format...",
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      });

      const pricerSkus = await dataSource.convertToPricerSku(validatedData);

      if (config.isCancelled?.()) {
        throw new Error("Processing cancelled by user");
      }

      // Step 3.5: Fetch price points for bounds checking (server-side only)
      const skuIds = pricerSkus.map((sku) => sku.sku);
      const pricePointsMap =
        await this.enrichmentService.fetchPricePointsForPricing(
          skuIds,
          (current, total, status) => {
            config.onProgress?.({
              current,
              total,
              status,
              processed: 0,
              skipped: 0,
              errors: 0,
              warnings: 0,
            });
          }
        );

      if (config.isCancelled?.()) {
        throw new Error("Processing cancelled by user");
      }

      // Step 3.6: Pre-enrich for display purposes if enrichment is enabled
      let productDisplayMap:
        | Map<number, import("./dataEnrichmentService").ProductDisplayInfo>
        | undefined;
      if (config.enableEnrichment !== false) {
        config.onProgress?.({
          current: 0,
          total: skuIds.length,
          status: "Fetching product details for display...",
          processed: 0,
          skipped: 0,
          errors: 0,
          warnings: 0,
        });

        // Fetch just the product details needed for display names
        productDisplayMap = await this.enrichmentService.fetchProductDetails(
          skuIds,
          (current: number, total: number, status: string) => {
            config.onProgress?.({
              current,
              total,
              status,
              processed: 0,
              skipped: 0,
              errors: 0,
              warnings: 0,
            });
          }
        );

        if (config.isCancelled?.()) {
          throw new Error("Processing cancelled by user");
        }
      }

      // Step 4: Execute core pricing with price points and display info
      // Supply analysis (if enabled) will be handled at the individual SKU level in getSuggestedPrice calls
      const pricingResult = await this.pricingCalculator.calculatePrices(
        pricerSkus,
        config,
        pricePointsMap,
        config.source,
        productDisplayMap
      );

      if (config.isCancelled?.()) {
        throw new Error("Processing cancelled by user");
      }

      let finalPricedSkus: PricedSku[];

      // Step 5: Enrich with supplementary data (optional, parallel)
      if (config.enableEnrichment !== false) {
        config.onProgress?.({
          current: 0,
          total: pricingResult.pricedItems.length,
          status: "Enriching with supplementary data...",
          processed: pricingResult.stats.processed,
          skipped: pricingResult.stats.skipped,
          errors: pricingResult.stats.errors,
          warnings: pricingResult.stats.warnings,
        });

        finalPricedSkus = await this.enrichmentService.enrichForDisplay(
          pricingResult.pricedItems,
          (current, total, status) => {
            config.onProgress?.({
              current,
              total,
              status,
              processed: pricingResult.stats.processed,
              skipped: pricingResult.stats.skipped,
              errors: pricingResult.stats.errors,
              warnings: pricingResult.stats.warnings,
            });
          },
          pricePointsMap // Pass the already-fetched price points to avoid redundant API calls
        );
      } else {
        // Convert pricing data to PricedSku format without enrichment
        finalPricedSkus = pricingResult.pricedItems.map((item) => ({
          ...item,
          // Add missing PricedSku properties with default values
          productLine: undefined,
          setName: undefined,
          productName: undefined,
          condition: undefined,
          variant: undefined,
          lowestSalePrice: undefined,
          highestSalePrice: undefined,
          saleCount: undefined,
          tcgMarketPrice: undefined,
          // Include time-related fields from pricing result
          historicalSalesVelocityDays: item.historicalSalesVelocityDays,
          estimatedTimeToSellDays: item.estimatedTimeToSellDays,
          salesCountForHistorical: item.salesCountForHistorical,
          listingsCountForEstimated: item.listingsCountForEstimated,
        }));
      }

      if (config.isCancelled?.()) {
        throw new Error("Processing cancelled by user");
      }

      // Step 6: Export results (optional)
      let exportInfo: PipelineResult["exportInfo"];
      if (config.enableExport !== false) {
        config.onProgress?.({
          current: finalPricedSkus.length,
          total: finalPricedSkus.length,
          status: "Preparing export...",
          processed: pricingResult.stats.processed,
          skipped: pricingResult.stats.skipped,
          errors: pricingResult.stats.errors,
          warnings: pricingResult.stats.warnings,
        });

        // Split results into successfully priced and failed items
        // Only items with actual errors (not just warnings) go to manual review
        const successfullyPriced = finalPricedSkus.filter(
          (sku) =>
            sku.price !== undefined &&
            sku.price !== null &&
            sku.price > 0 &&
            (!sku.errors || sku.errors.length === 0)
        );
        const failedPricing = finalPricedSkus.filter(
          (sku) =>
            sku.price === undefined ||
            sku.price === null ||
            sku.price <= 0 ||
            (sku.errors && sku.errors.length > 0)
        );

        // Sort successfully priced items by product line, set name, then product
        const sortedSuccessfullyPriced = [...successfullyPriced].sort(
          (a, b) => {
            // First sort by product line
            const productLineA = a.productLine || "";
            const productLineB = b.productLine || "";
            if (productLineA !== productLineB) {
              return productLineA.localeCompare(productLineB);
            }

            // Then sort by set name
            const setNameA = a.setName || "";
            const setNameB = b.setName || "";
            if (setNameA !== setNameB) {
              return setNameA.localeCompare(setNameB);
            }

            // Finally sort by product name
            const productNameA = a.productName || "";
            const productNameB = b.productName || "";
            return productNameA.localeCompare(productNameB);
          }
        );

        // Export main file with successfully priced items
        const csvData = this.outputConverter.convertFromPricedSkus(
          sortedSuccessfullyPriced
        );
        const filename =
          config.filename || `priced-${config.source}-${Date.now()}.csv`;
        downloadCSV(csvData, filename);

        // Export failed items to separate file for manual review
        let manualReviewFile: string | undefined;
        if (failedPricing.length > 0) {
          // Sort failed items as well
          const sortedFailedPricing = [...failedPricing].sort((a, b) => {
            // First sort by product line
            const productLineA = a.productLine || "";
            const productLineB = b.productLine || "";
            if (productLineA !== productLineB) {
              return productLineA.localeCompare(productLineB);
            }

            // Then sort by set name
            const setNameA = a.setName || "";
            const setNameB = b.setName || "";
            if (setNameA !== setNameB) {
              return setNameA.localeCompare(setNameB);
            }

            // Finally sort by product name
            const productNameA = a.productName || "";
            const productNameB = b.productName || "";
            return productNameA.localeCompare(productNameB);
          });

          const failedCsvData =
            this.outputConverter.convertFromPricedSkus(sortedFailedPricing);
          manualReviewFile = config.filename
            ? config.filename.replace(".csv", "-manual-review.csv")
            : `priced-${config.source}-${Date.now()}-manual-review.csv`;
          downloadCSV(failedCsvData, manualReviewFile);
        }

        exportInfo = {
          mainFile: filename,
          manualReviewFile,
          successfulCount: sortedSuccessfullyPriced.length,
          failedCount: failedPricing.length,
        };
      }

      // Create summary
      const totalProcessingTime = Date.now() - startTime;
      const summary = this.createProcessingSummary(
        config.source,
        config.percentile,
        rawData.length,
        pricingResult.stats,
        finalPricedSkus,
        totalProcessingTime,
        pricingResult.aggregatedPercentiles
      );

      return {
        pricedSkus: finalPricedSkus,
        summary,
        exportInfo,
      };
    } catch (error: any) {
      if (error.message === "Processing cancelled by user") {
        throw error;
      }
      config.onError?.(error?.message || "Pipeline execution failed");
      throw error;
    }
  }

  private createProcessingSummary(
    source: string,
    percentile: number,
    totalRows: number,
    stats: {
      processed: number;
      skipped: number;
      errors: number;
      warnings: number;
    },
    pricedSkus: PricedSku[],
    processingTime: number,
    aggregatedPercentiles: {
      marketPrice: { [key: string]: number };
      historicalSalesVelocity: { [key: string]: number };
      estimatedTimeToSell: { [key: string]: number };
    }
  ): ProcessingSummary {
    // Calculate totals from priced SKUs
    let totalQuantity = 0;
    let totalAddQuantity = 0;
    let marketPriceTotal = 0;
    let lowPriceTotal = 0;
    let marketplacePriceTotal = 0;

    pricedSkus.forEach((sku) => {
      const qty = (sku.quantity || 0) + (sku.addToQuantity || 0);
      totalQuantity += sku.quantity || 0;
      totalAddQuantity += sku.addToQuantity || 0;

      if (sku.tcgMarketPrice) {
        marketPriceTotal += sku.tcgMarketPrice * qty;
      }
      if (sku.lowestSalePrice) {
        lowPriceTotal += sku.lowestSalePrice * qty;
      }
      if (sku.price) {
        marketplacePriceTotal += sku.price * qty;
      }
    });

    const totalProcessed = stats.processed + stats.errors;
    const successRate =
      totalProcessed > 0 ? (stats.processed / totalProcessed) * 100 : 0;

    return {
      totalRows,
      processedRows: stats.processed,
      skippedRows: stats.skipped,
      errorRows: stats.errors,
      warningRows: stats.warnings,
      successRate,
      processingTime,
      fileName: source,
      percentileUsed: percentile,
      totalQuantity,
      totalAddQuantity,
      totals: {
        marketPrice: marketPriceTotal,
        lowPrice: lowPriceTotal,
        marketplacePrice: marketplacePriceTotal,
        percentiles: aggregatedPercentiles.marketPrice,
      },
      totalsWithMarket: {
        marketPrice: marketPriceTotal,
        percentiles: aggregatedPercentiles.marketPrice,
        quantityWithMarket: totalQuantity + totalAddQuantity,
      },
      medianDaysToSell: {
        historicalSalesVelocity: 0, // This should be calculated from the aggregated data
        estimatedTimeToSell:
          Object.keys(aggregatedPercentiles.estimatedTimeToSell).length > 0
            ? 0
            : undefined,
        percentiles: aggregatedPercentiles.historicalSalesVelocity,
        marketAdjustedPercentiles:
          Object.keys(aggregatedPercentiles.estimatedTimeToSell).length > 0
            ? aggregatedPercentiles.estimatedTimeToSell
            : undefined,
      },
    };
  }
}
