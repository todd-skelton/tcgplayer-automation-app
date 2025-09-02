import type {
  PricedSku,
  PricingConfig,
  ProcessingSummary,
} from "../types/pricing";
import type { DataSourceService } from "./dataSourceInterfaces";
import {
  PricingOrchestrator,
  type PipelineConfig,
} from "./pricingOrchestrator";
import {
  getMigrationConfig,
  shouldUsePurePipeline,
} from "../config/migrationConfig";

/**
 * Result comparison between old and new pipelines
 */
interface PipelineComparison {
  oldResult: PricedSku[];
  newResult: PricedSku[];
  differences: SkuDifference[];
  summary: ComparisonSummary;
}

interface SkuDifference {
  sku: number;
  field: string;
  oldValue: any;
  newValue: any;
  percentageDifference?: number;
}

interface ComparisonSummary {
  totalSkus: number;
  identicalResults: number;
  similarResults: number; // Within tolerance
  significantDifferences: number;
  toleranceThreshold: number;
  recommendUseNew: boolean;
}

/**
 * Migration orchestrator that handles the transition between old and new pipelines
 * Includes parallel testing, validation, and rollback capabilities
 */
export class MigrationOrchestrator {
  private originalOrchestrator = new PricingOrchestrator();
  private migrationConfig = getMigrationConfig();

  /**
   * Main execution method that chooses pipeline based on migration config
   */
  async executePipeline<TInput>(
    dataSource: DataSourceService<TInput>,
    sourceParams: any,
    config: PipelineConfig,
    userId?: string
  ) {
    const usePurePipeline =
      config.usePurePipeline ?? shouldUsePurePipeline(userId);

    if (
      this.migrationConfig.enableParallelTesting &&
      this.migrationConfig.validateResultsAgainstOldPipeline
    ) {
      // Run both pipelines and compare results
      return await this.executeWithParallelTesting(
        dataSource,
        sourceParams,
        config
      );
    }

    if (usePurePipeline) {
      return await this.executeNewPipeline(dataSource, sourceParams, config);
    } else {
      return await this.executeOriginalPipeline(
        dataSource,
        sourceParams,
        config
      );
    }
  }

  /**
   * Execute new pure pipeline with error handling and rollback
   */
  private async executeNewPipeline<TInput>(
    dataSource: DataSourceService<TInput>,
    sourceParams: any,
    config: PipelineConfig
  ) {
    try {
      if (this.migrationConfig.enableDetailedLogging) {
        console.log("🚀 Executing new pure pipeline");
      }

      const result = await this.originalOrchestrator.executePurePipeline(
        dataSource,
        sourceParams,
        config
      );

      // Validate result quality
      const validationResult = this.validatePipelineResult(result);

      if (
        !validationResult.isValid &&
        this.migrationConfig.enableAutoRollback
      ) {
        console.warn(
          "⚠️ New pipeline validation failed, falling back to original"
        );
        return await this.executeOriginalPipeline(
          dataSource,
          sourceParams,
          config
        );
      }

      if (this.migrationConfig.enableDetailedLogging) {
        console.log("✅ New pipeline executed successfully", validationResult);
      }

      return result;
    } catch (error) {
      console.error("❌ New pipeline failed:", error);

      if (this.migrationConfig.enableAutoRollback) {
        console.log("🔄 Falling back to original pipeline");
        return await this.executeOriginalPipeline(
          dataSource,
          sourceParams,
          config
        );
      }

      throw error;
    }
  }

  /**
   * Execute original pipeline
   */
  private async executeOriginalPipeline<TInput>(
    dataSource: DataSourceService<TInput>,
    sourceParams: any,
    config: PipelineConfig
  ) {
    if (this.migrationConfig.enableDetailedLogging) {
      console.log("🔄 Executing original pipeline");
    }

    return await this.originalOrchestrator.executePipeline(
      dataSource,
      sourceParams,
      config
    );
  }

  /**
   * Execute both pipelines in parallel and compare results
   */
  private async executeWithParallelTesting<TInput>(
    dataSource: DataSourceService<TInput>,
    sourceParams: any,
    config: PipelineConfig
  ) {
    console.log("🔬 Running parallel pipeline testing");

    const startTime = Date.now();

    // Run both pipelines in parallel
    const [originalResult, newResult] = await Promise.allSettled([
      this.executeOriginalPipeline(dataSource, sourceParams, config),
      this.executeNewPipeline(dataSource, sourceParams, config),
    ]);

    const endTime = Date.now();

    // Handle execution results
    if (
      originalResult.status === "rejected" &&
      newResult.status === "rejected"
    ) {
      throw new Error("Both pipelines failed during parallel testing");
    }

    if (originalResult.status === "rejected") {
      console.warn(
        "⚠️ Original pipeline failed during testing, using new pipeline"
      );
      return newResult.status === "fulfilled"
        ? newResult.value
        : Promise.reject(newResult.reason);
    }

    if (newResult.status === "rejected") {
      console.warn(
        "⚠️ New pipeline failed during testing, using original pipeline"
      );
      return originalResult.value;
    }

    // Compare results
    const comparison = this.compareResults(
      originalResult.value,
      newResult.value
    );

    if (this.migrationConfig.enableDetailedLogging) {
      console.log("📊 Pipeline comparison results:", {
        executionTime: endTime - startTime,
        comparison: comparison.summary,
      });
    }

    // Log significant differences
    if (comparison.differences.length > 0) {
      console.log(
        "🔍 Found differences between pipelines:",
        comparison.differences.slice(0, 10)
      );
    }

    // Decide which result to return
    if (comparison.summary.recommendUseNew) {
      console.log("✅ New pipeline recommended, using new results");
      return newResult.value;
    } else {
      console.log("🔄 Sticking with original pipeline results");
      return originalResult.value;
    }
  }

  /**
   * Compare results between old and new pipelines
   */
  private compareResults(
    originalResult: any,
    newResult: any
  ): PipelineComparison {
    const differences: SkuDifference[] = [];
    const toleranceThreshold = 0.05; // 5% tolerance for price differences

    const oldSkus = originalResult.pricedSkus;
    const newSkus = newResult.pricedSkus;

    // Create maps for easier comparison
    const oldSkuMap = new Map(oldSkus.map((sku: PricedSku) => [sku.sku, sku]));
    const newSkuMap = new Map(newSkus.map((sku: PricedSku) => [sku.sku, sku]));

    let identicalResults = 0;
    let similarResults = 0;
    let significantDifferences = 0;

    // Compare each SKU
    for (const [skuId, oldSku] of oldSkuMap) {
      const newSku = newSkuMap.get(skuId) as PricedSku;

      if (!newSku) {
        differences.push({
          sku: skuId as number,
          field: "existence",
          oldValue: "present",
          newValue: "missing",
        });
        significantDifferences++;
        continue;
      }

      const oldSkuTyped = oldSku as PricedSku;

      // Compare prices
      const priceDiff = this.comparePrices(
        oldSkuTyped.price,
        newSku.price,
        toleranceThreshold
      );
      if (priceDiff) {
        differences.push({
          sku: skuId as number,
          field: "price",
          oldValue: oldSkuTyped.price,
          newValue: newSku.price,
          percentageDifference: priceDiff.percentageDifference,
        });

        if (priceDiff.isSignificant) {
          significantDifferences++;
        } else {
          similarResults++;
        }
      } else {
        identicalResults++;
      }

      // Compare other important fields
      const fieldsToCompare: (keyof PricedSku)[] = [
        "suggestedPrice",
        "historicalSalesVelocityDays",
        "estimatedTimeToSellDays",
      ];

      fieldsToCompare.forEach((field) => {
        const oldValue = oldSkuTyped[field];
        const newValue = newSku[field];

        if (oldValue !== newValue) {
          const diff = this.calculatePercentageDifference(oldValue, newValue);
          differences.push({
            sku: skuId as number,
            field: field as string,
            oldValue,
            newValue,
            percentageDifference: diff,
          });
        }
      });
    }

    // Check for new SKUs not in old results
    for (const [skuId, newSku] of newSkuMap) {
      if (!oldSkuMap.has(skuId)) {
        differences.push({
          sku: skuId as number,
          field: "existence",
          oldValue: "missing",
          newValue: "present",
        });
      }
    }

    const totalSkus = Math.max(oldSkus.length, newSkus.length);
    const recommendUseNew =
      significantDifferences / totalSkus <
      this.migrationConfig.maxErrorThreshold / 100;

    return {
      oldResult: oldSkus,
      newResult: newSkus,
      differences,
      summary: {
        totalSkus,
        identicalResults,
        similarResults,
        significantDifferences,
        toleranceThreshold,
        recommendUseNew,
      },
    };
  }

  /**
   * Compare two price values with tolerance
   */
  private comparePrices(
    oldPrice: number | undefined,
    newPrice: number | undefined,
    tolerance: number
  ): { percentageDifference: number; isSignificant: boolean } | null {
    if (oldPrice === undefined && newPrice === undefined) return null;
    if (oldPrice === undefined || newPrice === undefined) {
      return { percentageDifference: 100, isSignificant: true };
    }

    const percentageDifference =
      (Math.abs(oldPrice - newPrice) / oldPrice) * 100;
    const isSignificant = percentageDifference > tolerance * 100;

    return { percentageDifference, isSignificant };
  }

  /**
   * Calculate percentage difference between two numeric values
   */
  private calculatePercentageDifference(oldValue: any, newValue: any): number {
    if (typeof oldValue !== "number" || typeof newValue !== "number") {
      return oldValue === newValue ? 0 : 100;
    }

    if (oldValue === 0) return newValue === 0 ? 0 : 100;

    return (Math.abs(oldValue - newValue) / oldValue) * 100;
  }

  /**
   * Validate pipeline result quality
   */
  private validatePipelineResult(result: any): {
    isValid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    if (!result || !result.pricedSkus) {
      issues.push("Missing pricedSkus in result");
      return { isValid: false, issues };
    }

    const skus = result.pricedSkus;
    const totalSkus = skus.length;

    if (totalSkus === 0) {
      issues.push("No SKUs processed");
      return { isValid: false, issues };
    }

    // Check error rate
    const skusWithErrors = skus.filter(
      (sku: PricedSku) => sku.errors && sku.errors.length > 0
    );
    const errorRate = (skusWithErrors.length / totalSkus) * 100;

    if (errorRate > this.migrationConfig.maxErrorThreshold) {
      issues.push(
        `Error rate too high: ${errorRate.toFixed(1)}% (threshold: ${
          this.migrationConfig.maxErrorThreshold
        }%)`
      );
    }

    // Check for reasonable prices
    const skusWithPrices = skus.filter(
      (sku: PricedSku) => sku.price && sku.price > 0
    );
    const pricingSuccessRate = (skusWithPrices.length / totalSkus) * 100;

    if (pricingSuccessRate < 50) {
      issues.push(
        `Low pricing success rate: ${pricingSuccessRate.toFixed(1)}%`
      );
    }

    // Check for extreme prices (potential bugs)
    const extremePrices = skusWithPrices.filter(
      (sku: PricedSku) => sku.price! > 10000 || sku.price! < 0.01
    );

    if (extremePrices.length > 0) {
      issues.push(`Found ${extremePrices.length} SKUs with extreme prices`);
    }

    return {
      isValid: issues.length === 0,
      issues,
    };
  }

  /**
   * Get migration status and metrics
   */
  getMigrationStatus() {
    return {
      config: this.migrationConfig,
      phase: this.getCurrentPhase(),
      recommendations: this.getRecommendations(),
    };
  }

  private getCurrentPhase() {
    // Implementation would track current migration phase
    return "testing";
  }

  private getRecommendations() {
    // Implementation would provide recommendations based on test results
    return [
      "Continue parallel testing for 1 week",
      "Monitor error rates closely",
      "Prepare rollback plan",
    ];
  }
}
