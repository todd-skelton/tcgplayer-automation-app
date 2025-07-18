import type {
  PricedSku,
  PricingConfig,
  ProcessingSummary,
} from "../types/pricing";
import type { DataSourceService } from "./dataSourceInterfaces";
import { PricingCalculator } from "./pricingCalculator";
import { DataEnrichmentService } from "./dataEnrichmentService";
import { PricedSkuToTcgPlayerListingConverter } from "./dataConverters";
import { downloadCSV } from "../utils/csvProcessing";

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
}

/**
 * Orchestrates the complete pricing pipeline with proper separation of concerns
 */
export class PricingOrchestrator {
  private pricingCalculator = new PricingCalculator();
  private enrichmentService = new DataEnrichmentService();
  private outputConverter = new PricedSkuToTcgPlayerListingConverter();

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
            });
          }
        );

      if (config.isCancelled?.()) {
        throw new Error("Processing cancelled by user");
      }

      // Step 4: Execute core pricing with price points (fast, no additional enrichment)
      const pricingResult = await this.pricingCalculator.calculatePrices(
        pricerSkus,
        config,
        pricePointsMap,
        config.source
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
        });

        // Split results into successfully priced and failed items
        const successfullyPriced = finalPricedSkus.filter(
          (sku) =>
            sku.price !== undefined && sku.price !== null && sku.price > 0
        );
        const failedPricing = finalPricedSkus.filter(
          (sku) =>
            sku.price === undefined || sku.price === null || sku.price <= 0
        );

        // Export main file with successfully priced items
        const csvData =
          this.outputConverter.convertFromPricedSkus(successfullyPriced);
        const filename =
          config.filename || `priced-${config.source}-${Date.now()}.csv`;
        downloadCSV(csvData, filename);

        // Export failed items to separate file for manual review
        let manualReviewFile: string | undefined;
        if (failedPricing.length > 0) {
          const failedCsvData =
            this.outputConverter.convertFromPricedSkus(failedPricing);
          manualReviewFile = config.filename
            ? config.filename.replace(".csv", "-manual-review.csv")
            : `priced-${config.source}-${Date.now()}-manual-review.csv`;
          downloadCSV(failedCsvData, manualReviewFile);
        }

        exportInfo = {
          mainFile: filename,
          manualReviewFile,
          successfulCount: successfullyPriced.length,
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
    stats: { processed: number; skipped: number; errors: number },
    pricedSkus: PricedSku[],
    processingTime: number,
    aggregatedPercentiles: {
      marketPrice: { [key: string]: number };
      expectedDaysToSell: { [key: string]: number };
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
        expectedDaysToSell: 0,
        percentiles: aggregatedPercentiles.expectedDaysToSell,
      },
    };
  }
}
