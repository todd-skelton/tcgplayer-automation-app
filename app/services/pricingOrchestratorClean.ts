import type {
  PricedSku,
  PricingConfig,
  ProcessingSummary,
  PricerSku,
  TcgPlayerListing,
} from "../types/pricing";
import type { DataSourceService } from "./dataSourceInterfaces";
import {
  PricingCalculator,
  type PricingCalculationResult,
} from "./pricingCalculator";
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
  onProgress?: (progress: {
    current: number;
    total: number;
    status: string;
    processed: number;
    skipped: number;
    errors: number;
    warnings: number;
  }) => void;
  isCancelled?: () => boolean;
}

/**
 * Orchestrates the complete pricing pipeline with client-safe implementation
 * This version does not include server-side database dependencies for client safety
 * All data gathering and external API calls should be done via server API routes
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
      // Step 1: Source and validate data
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
      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      const validatedData = await dataSource.validateData(rawData);
      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      const sourceSkus = await dataSource.convertToPricerSku(validatedData);
      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      config.onProgress?.({
        current: 1,
        total: 6,
        status: `Found ${sourceSkus.length} SKUs, preparing for pricing...`,
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
      });

      // Step 2: Filter valid SKUs
      const validSkus = sourceSkus.filter((sku: PricerSku) => {
        return sku.sku && sku.sku > 0;
      });

      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      config.onProgress?.({
        current: 2,
        total: 6,
        status: `Validated ${validSkus.length} SKUs, fetching price points...`,
        processed: 0,
        skipped: sourceSkus.length - validSkus.length,
        errors: 0,
        warnings: 0,
      });

      // Step 3: Fetch price points for pricing
      const skuIds = validSkus.map((sku) => sku.sku);
      const pricePointsMap =
        await this.enrichmentService.fetchPricePointsForPricing(
          skuIds,
          (current, total, status) => {
            config.onProgress?.({
              current: 3,
              total: 6,
              status,
              processed: current,
              skipped: sourceSkus.length - validSkus.length,
              errors: 0,
              warnings: 0,
            });
          }
        );

      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      config.onProgress?.({
        current: 4,
        total: 6,
        status: "Calculating pricing...",
        processed: 0,
        skipped: sourceSkus.length - validSkus.length,
        errors: 0,
        warnings: 0,
      });

      // Step 4: Execute core pricing calculations
      const pricingResult = await this.pricingCalculator.calculatePrices(
        validSkus,
        config,
        pricePointsMap,
        config.source
      );

      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      config.onProgress?.({
        current: 5,
        total: 6,
        status: "Enriching pricing data for display...",
        processed: pricingResult.stats.processed,
        skipped: sourceSkus.length - validSkus.length,
        errors: pricingResult.stats.errors,
        warnings: pricingResult.stats.warnings,
      });

      // Step 5: Enrich for display
      const enrichedSkus = await this.enrichmentService.enrichForDisplay(
        pricingResult.pricedItems,
        (current: number, total: number, status: string) => {
          config.onProgress?.({
            current: 5,
            total: 6,
            status,
            processed: current,
            skipped: sourceSkus.length - validSkus.length,
            errors: pricingResult.stats.errors,
            warnings: pricingResult.stats.warnings,
          });
        }
      );

      // Step 6: Generate export files if requested
      let exportInfo;
      if (config.enableExport) {
        config.onProgress?.({
          current: 6,
          total: 6,
          status: "Generating export files...",
          processed: enrichedSkus.length,
          skipped: sourceSkus.length - validSkus.length,
          errors: pricingResult.stats.errors,
          warnings: pricingResult.stats.warnings,
        });

        const exportData =
          this.outputConverter.convertFromPricedSkus(enrichedSkus);
        downloadCSV(exportData, "pricing-results");

        exportInfo = {
          mainFile: "pricing-results.csv",
          successfulCount: exportData.length,
          failedCount: 0,
        };
      }

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      // Create summary
      const summary: ProcessingSummary = {
        totalRows: sourceSkus.length,
        processedRows: enrichedSkus.length,
        skippedRows: sourceSkus.length - validSkus.length,
        errorRows: pricingResult.stats.errors,
        warningRows: pricingResult.stats.warnings,
        successRate: (enrichedSkus.length / sourceSkus.length) * 100,
        processingTime,
        fileName: config.source,
        percentileUsed: config.percentile,
        totalQuantity: enrichedSkus.reduce(
          (sum: number, sku: PricedSku) => sum + (sku.quantity || 0),
          0
        ),
        totalAddQuantity: enrichedSkus.reduce(
          (sum: number, sku: PricedSku) => sum + (sku.addToQuantity || 0),
          0
        ),
        totals: {
          marketPrice: enrichedSkus.reduce(
            (sum: number, sku: PricedSku) => sum + (sku.tcgMarketPrice || 0),
            0
          ),
          lowPrice: enrichedSkus.reduce(
            (sum: number, sku: PricedSku) => sum + (sku.lowestSalePrice || 0),
            0
          ),
          marketplacePrice: enrichedSkus.reduce(
            (sum: number, sku: PricedSku) => sum + (sku.price || 0),
            0
          ),
          percentiles: pricingResult.aggregatedPercentiles.marketPrice,
        },
        totalsWithMarket: {
          marketPrice: enrichedSkus.reduce(
            (sum: number, sku: PricedSku) => sum + (sku.tcgMarketPrice || 0),
            0
          ),
          percentiles: pricingResult.aggregatedPercentiles.marketPrice,
          quantityWithMarket: enrichedSkus.filter((sku) => sku.tcgMarketPrice)
            .length,
        },
        medianDaysToSell: {
          historicalSalesVelocity: 0,
          percentiles:
            pricingResult.aggregatedPercentiles.historicalSalesVelocity,
          marketAdjustedPercentiles:
            pricingResult.aggregatedPercentiles.estimatedTimeToSell,
        },
      };

      config.onProgress?.({
        current: 6,
        total: 6,
        status: "Complete",
        processed: enrichedSkus.length,
        skipped: sourceSkus.length - validSkus.length,
        errors: pricingResult.stats.errors,
        warnings: pricingResult.stats.warnings,
      });

      return {
        pricedSkus: enrichedSkus,
        summary,
        exportInfo,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("cancelled")) {
        throw error;
      }

      throw new Error(
        `Pipeline execution failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}
