import type {
  PricedSku,
  PricingConfig,
  ProcessingSummary,
  PricerSku,
  TcgPlayerListing,
  ProcessingProgress,
} from "../../../core/types/pricing";
import type { DataSourceService } from "../../../shared/services/dataSourceInterfaces";
import {
  PricingCalculator,
  type PricingCalculationResult,
} from "./pricingCalculator";
import { DataEnrichmentService } from "../../../shared/services/dataEnrichmentService";
import { PricedSkuToTcgPlayerListingConverter } from "../../file-upload/services/dataConverters";
import { downloadCSV } from "../../../core/utils/csvProcessing";

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
  filename?: string;
  enableEnrichment?: boolean;
  enableExport?: boolean;
  onProgress?: (progress: ProcessingProgress) => void;
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
      const phaseStartTime = Date.now();
      config.onProgress?.({
        current: 0,
        total: 6,
        status: "Fetching and validating data...",
        processed: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
        phase: "Data Validation",
        phaseStartTime,
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
        phase: "Preparing Price Data",
        phaseStartTime: Date.now(),
      });

      // Step 3: Fetch price points for pricing
      const skuIds = validSkus.map((sku) => sku.sku);
      const step3StartTime = Date.now();
      const pricePointsMap =
        await this.enrichmentService.fetchPricePointsForPricing(
          skuIds,
          (current, total, status) => {
            config.onProgress?.({
              current: 3,
              total: 6,
              status: "Fetching price points...",
              processed: 0,
              skipped: sourceSkus.length - validSkus.length,
              errors: 0,
              warnings: 0,
              phase: "Fetching Price Data",
              subProgress: {
                current,
                total,
                status,
              },
              phaseStartTime: step3StartTime,
            });
          }
        );

      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      const step4StartTime = Date.now();
      config.onProgress?.({
        current: 4,
        total: 6,
        status: "Calculating pricing...",
        processed: 0,
        skipped: sourceSkus.length - validSkus.length,
        errors: 0,
        warnings: 0,
        phase: "Calculating Prices",
        phaseStartTime: step4StartTime,
      });

      // Step 4: Execute core pricing calculations
      // Wrap the config to capture sub-progress from pricing calculator
      const wrappedConfig = {
        ...config,
        onProgress: (progress: any) => {
          config.onProgress?.({
            current: 4,
            total: 6,
            status: "Calculating pricing...",
            processed: progress.processed,
            skipped: sourceSkus.length - validSkus.length,
            errors: progress.errors,
            warnings: progress.warnings,
            phase: "Calculating Prices",
            subProgress: {
              current: progress.current,
              total: progress.total,
              status: progress.status,
            },
            phaseStartTime: step4StartTime,
          });
        },
      };
      const pricingResult = await this.pricingCalculator.calculatePrices(
        validSkus,
        wrappedConfig,
        pricePointsMap,
        config.source
      );

      if (config.isCancelled?.())
        throw new Error("Processing cancelled by user");

      const step5StartTime = Date.now();
      config.onProgress?.({
        current: 5,
        total: 6,
        status: "Enriching pricing data for display...",
        processed: pricingResult.stats.processed,
        skipped: sourceSkus.length - validSkus.length,
        errors: pricingResult.stats.errors,
        warnings: pricingResult.stats.warnings,
        phase: "Enriching Display Data",
        phaseStartTime: step5StartTime,
      });

      // Step 5: Enrich for display
      const enrichedSkus = await this.enrichmentService.enrichForDisplay(
        pricingResult.pricedItems,
        (current: number, total: number, status: string) => {
          config.onProgress?.({
            current: 5,
            total: 6,
            status: "Enriching display data...",
            processed: pricingResult.stats.processed,
            skipped: sourceSkus.length - validSkus.length,
            errors: pricingResult.stats.errors,
            warnings: pricingResult.stats.warnings,
            phase: "Enriching Display Data",
            subProgress: {
              current,
              total,
              status,
            },
            phaseStartTime: step5StartTime,
          });
        },
        pricePointsMap,
        undefined, // productLineIdHints will be extracted from originalPricerSkus
        validSkus // Pass original PricerSku data for productLineId hints
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
          phase: "Exporting",
          phaseStartTime: Date.now(),
        });

        // Separate successful from failed pricing (matching old logic)
        const successfullyPriced = enrichedSkus.filter(
          (sku) =>
            sku.price !== undefined &&
            sku.price !== null &&
            sku.price > 0 &&
            (!sku.errors || sku.errors.length === 0)
        );
        const failedPricing = enrichedSkus.filter(
          (sku) =>
            sku.price === undefined ||
            sku.price === null ||
            sku.price <= 0 ||
            (sku.errors && sku.errors.length > 0)
        );

        // Sort both lists by product line, set name, then product name
        const sortedSuccessfullyPriced = [...successfullyPriced].sort(
          (a, b) => {
            const aProductLine = a.productLine || "";
            const bProductLine = b.productLine || "";
            if (aProductLine !== bProductLine) {
              return aProductLine.localeCompare(bProductLine);
            }
            const aSetName = a.setName || "";
            const bSetName = b.setName || "";
            if (aSetName !== bSetName) {
              return aSetName.localeCompare(bSetName);
            }
            const aProductName = a.productName || "";
            const bProductName = b.productName || "";
            return aProductName.localeCompare(bProductName);
          }
        );

        const sortedFailedPricing = [...failedPricing].sort((a, b) => {
          const aProductLine = a.productLine || "";
          const bProductLine = b.productLine || "";
          if (aProductLine !== bProductLine) {
            return aProductLine.localeCompare(bProductLine);
          }
          const aSetName = a.setName || "";
          const bSetName = b.setName || "";
          if (aSetName !== bSetName) {
            return aSetName.localeCompare(bSetName);
          }
          const aProductName = a.productName || "";
          const bProductName = b.productName || "";
          return aProductName.localeCompare(bProductName);
        });

        // Export main file with successfully priced items
        const csvData = this.outputConverter.convertFromPricedSkus(
          sortedSuccessfullyPriced
        );
        const filename =
          config.filename || `priced-${config.source}-${Date.now()}.csv`;
        downloadCSV(csvData, filename);

        // Export manual review file with failed pricing items
        let manualReviewFile: string | undefined;
        if (sortedFailedPricing.length > 0) {
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
          failedCount: sortedFailedPricing.length,
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
          marketPrice: enrichedSkus.reduce((sum: number, sku: PricedSku) => {
            const combinedQty = (sku.quantity || 0) + (sku.addToQuantity || 0);
            return sum + (sku.tcgMarketPrice || 0) * combinedQty;
          }, 0),
          lowPrice: enrichedSkus.reduce((sum: number, sku: PricedSku) => {
            const combinedQty = (sku.quantity || 0) + (sku.addToQuantity || 0);
            return sum + (sku.lowestSalePrice || 0) * combinedQty;
          }, 0),
          marketplacePrice: enrichedSkus.reduce(
            (sum: number, sku: PricedSku) => {
              const combinedQty =
                (sku.quantity || 0) + (sku.addToQuantity || 0);
              return sum + (sku.price || 0) * combinedQty;
            },
            0
          ),
          percentiles: pricingResult.aggregatedPercentiles.marketPrice,
        },
        totalsWithMarket: {
          marketPrice: enrichedSkus.reduce((sum: number, sku: PricedSku) => {
            if (sku.tcgMarketPrice) {
              const combinedQty =
                (sku.quantity || 0) + (sku.addToQuantity || 0);
              return sum + (sku.tcgMarketPrice || 0) * combinedQty;
            }
            return sum;
          }, 0),
          percentiles: pricingResult.aggregatedPercentiles.marketPrice,
          quantityWithMarket: enrichedSkus
            .filter((sku) => sku.tcgMarketPrice)
            .reduce(
              (sum: number, sku: PricedSku) =>
                sum + (sku.quantity || 0) + (sku.addToQuantity || 0),
              0
            ),
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
        phase: "Complete",
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
