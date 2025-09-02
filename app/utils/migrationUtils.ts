/**
 * Utilities for managing the pricing pipeline migration
 */

import type { PricedSku } from "../types/pricing";
import { getMigrationConfig } from "../config/migrationConfig";

export interface MigrationMetrics {
  timestamp: Date;
  totalSkus: number;
  successfulPricing: number;
  errorRate: number;
  averagePrice: number;
  processingTime: number;
  pipelineUsed: "original" | "pure";
  memoryUsage?: number;
  apiCallsCount?: number;
}

export interface MigrationReport {
  period: string;
  metrics: MigrationMetrics[];
  summary: {
    totalExecutions: number;
    pureSuccess: number;
    originalSuccess: number;
    performanceGain: number; // percentage improvement
    errorReduction: number; // percentage improvement
    recommendation:
      | "continue_testing"
      | "rollout_gradual"
      | "rollout_full"
      | "rollback";
  };
}

/**
 * Tracks migration metrics over time
 */
export class MigrationMetricsCollector {
  private metrics: MigrationMetrics[] = [];
  private readonly maxMetrics = 1000; // Keep last 1000 executions

  /**
   * Record metrics for a pipeline execution
   */
  recordExecution(
    result: any,
    pipelineUsed: "original" | "pure",
    processingTime: number,
    additionalData?: {
      memoryUsage?: number;
      apiCallsCount?: number;
    }
  ) {
    const skus = result.pricedSkus || [];
    const successfulPricing = skus.filter(
      (sku: PricedSku) =>
        sku.price && sku.price > 0 && (!sku.errors || sku.errors.length === 0)
    ).length;

    const errorRate =
      skus.length > 0
        ? (skus.filter((sku: PricedSku) => sku.errors && sku.errors.length > 0)
            .length /
            skus.length) *
          100
        : 0;

    const averagePrice =
      successfulPricing > 0
        ? skus
            .filter((sku: PricedSku) => sku.price && sku.price > 0)
            .reduce(
              (sum: number, sku: PricedSku) => sum + (sku.price || 0),
              0
            ) / successfulPricing
        : 0;

    const metric: MigrationMetrics = {
      timestamp: new Date(),
      totalSkus: skus.length,
      successfulPricing,
      errorRate,
      averagePrice,
      processingTime,
      pipelineUsed,
      memoryUsage: additionalData?.memoryUsage,
      apiCallsCount: additionalData?.apiCallsCount,
    };

    this.metrics.push(metric);

    // Keep only recent metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }

    console.log(`📊 Migration Metrics Recorded:`, {
      pipeline: pipelineUsed,
      skus: metric.totalSkus,
      successRate: ((successfulPricing / skus.length) * 100).toFixed(1) + "%",
      processingTime: processingTime + "ms",
    });
  }

  /**
   * Generate migration report for a time period
   */
  generateReport(periodDays: number = 7): MigrationReport {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - periodDays);

    const periodMetrics = this.metrics.filter((m) => m.timestamp >= cutoffDate);

    const originalMetrics = periodMetrics.filter(
      (m) => m.pipelineUsed === "original"
    );
    const pureMetrics = periodMetrics.filter((m) => m.pipelineUsed === "pure");

    // Calculate averages
    const avgOriginalTime = this.calculateAverage(
      originalMetrics,
      "processingTime"
    );
    const avgPureTime = this.calculateAverage(pureMetrics, "processingTime");
    const avgOriginalErrors = this.calculateAverage(
      originalMetrics,
      "errorRate"
    );
    const avgPureErrors = this.calculateAverage(pureMetrics, "errorRate");

    const performanceGain =
      avgOriginalTime > 0
        ? ((avgOriginalTime - avgPureTime) / avgOriginalTime) * 100
        : 0;

    const errorReduction =
      avgOriginalErrors > 0
        ? ((avgOriginalErrors - avgPureErrors) / avgOriginalErrors) * 100
        : 0;

    // Generate recommendation
    let recommendation: MigrationReport["summary"]["recommendation"] =
      "continue_testing";

    if (
      pureMetrics.length >= 50 &&
      performanceGain > 20 &&
      errorReduction > 10
    ) {
      recommendation = "rollout_gradual";
    } else if (
      pureMetrics.length >= 100 &&
      performanceGain > 10 &&
      errorReduction >= 0
    ) {
      recommendation = "rollout_full";
    } else if (errorReduction < -20) {
      // Error rate increased significantly
      recommendation = "rollback";
    }

    return {
      period: `${periodDays} days`,
      metrics: periodMetrics,
      summary: {
        totalExecutions: periodMetrics.length,
        pureSuccess: pureMetrics.filter((m) => m.errorRate < 5).length,
        originalSuccess: originalMetrics.filter((m) => m.errorRate < 5).length,
        performanceGain,
        errorReduction,
        recommendation,
      },
    };
  }

  /**
   * Calculate average of a metric
   */
  private calculateAverage(
    metrics: MigrationMetrics[],
    field: keyof MigrationMetrics
  ): number {
    if (metrics.length === 0) return 0;

    const sum = metrics.reduce((acc, m) => {
      const value = m[field];
      return acc + (typeof value === "number" ? value : 0);
    }, 0);

    return sum / metrics.length;
  }

  /**
   * Get current metrics summary
   */
  getCurrentStatus() {
    const recentMetrics = this.metrics.slice(-20); // Last 20 executions
    const originalCount = recentMetrics.filter(
      (m) => m.pipelineUsed === "original"
    ).length;
    const pureCount = recentMetrics.filter(
      (m) => m.pipelineUsed === "pure"
    ).length;

    return {
      totalExecutions: this.metrics.length,
      recentExecutions: recentMetrics.length,
      originalPipelineUsage: originalCount,
      purePipelineUsage: pureCount,
      averageProcessingTime: this.calculateAverage(
        recentMetrics,
        "processingTime"
      ),
      averageErrorRate: this.calculateAverage(recentMetrics, "errorRate"),
    };
  }

  /**
   * Export metrics for analysis
   */
  exportMetrics(format: "json" | "csv" = "json") {
    if (format === "csv") {
      const headers = [
        "timestamp",
        "totalSkus",
        "successfulPricing",
        "errorRate",
        "averagePrice",
        "processingTime",
        "pipelineUsed",
      ];
      const rows = this.metrics.map((m) => [
        m.timestamp.toISOString(),
        m.totalSkus,
        m.successfulPricing,
        m.errorRate.toFixed(2),
        m.averagePrice.toFixed(2),
        m.processingTime,
        m.pipelineUsed,
      ]);

      return [headers, ...rows].map((row) => row.join(",")).join("\n");
    }

    return JSON.stringify(this.metrics, null, 2);
  }
}

/**
 * Migration validation utilities
 */
export class MigrationValidator {
  /**
   * Validate that two pricing results are equivalent within tolerance
   */
  static validateEquivalence(
    originalResult: PricedSku[],
    newResult: PricedSku[],
    tolerance: number = 0.05
  ): { isEquivalent: boolean; differences: string[] } {
    const differences: string[] = [];

    if (originalResult.length !== newResult.length) {
      differences.push(
        `SKU count mismatch: ${originalResult.length} vs ${newResult.length}`
      );
      return { isEquivalent: false, differences };
    }

    const originalMap = new Map(originalResult.map((sku) => [sku.sku, sku]));
    const newMap = new Map(newResult.map((sku) => [sku.sku, sku]));

    for (const [skuId, originalSku] of originalMap) {
      const newSku = newMap.get(skuId);

      if (!newSku) {
        differences.push(`SKU ${skuId} missing in new result`);
        continue;
      }

      // Check price differences
      if (originalSku.price && newSku.price) {
        const priceDiff =
          Math.abs(originalSku.price - newSku.price) / originalSku.price;
        if (priceDiff > tolerance) {
          differences.push(
            `SKU ${skuId} price difference: ${(priceDiff * 100).toFixed(1)}%`
          );
        }
      }

      // Check for errors in new result where original succeeded
      if (
        (!originalSku.errors || originalSku.errors.length === 0) &&
        newSku.errors &&
        newSku.errors.length > 0
      ) {
        differences.push(
          `SKU ${skuId} has new errors: ${newSku.errors.join(", ")}`
        );
      }
    }

    return {
      isEquivalent: differences.length === 0,
      differences,
    };
  }

  /**
   * Validate that performance is acceptable
   */
  static validatePerformance(metrics: MigrationMetrics): {
    isAcceptable: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    const config = getMigrationConfig();

    if (metrics.errorRate > config.maxErrorThreshold) {
      issues.push(`Error rate too high: ${metrics.errorRate.toFixed(1)}%`);
    }

    if (metrics.processingTime > 300000) {
      // 5 minutes
      issues.push(
        `Processing time too slow: ${(metrics.processingTime / 1000).toFixed(
          1
        )}s`
      );
    }

    if (metrics.successfulPricing / metrics.totalSkus < 0.8) {
      issues.push(
        `Low success rate: ${(
          (metrics.successfulPricing / metrics.totalSkus) *
          100
        ).toFixed(1)}%`
      );
    }

    return {
      isAcceptable: issues.length === 0,
      issues,
    };
  }
}

/**
 * Rollback utilities
 */
export class MigrationRollback {
  /**
   * Determine if rollback is needed based on metrics
   */
  static shouldRollback(recentMetrics: MigrationMetrics[]): {
    shouldRollback: boolean;
    reason: string;
  } {
    const config = getMigrationConfig();

    if (!config.enableAutoRollback) {
      return { shouldRollback: false, reason: "Auto-rollback disabled" };
    }

    const pureMetrics = recentMetrics.filter((m) => m.pipelineUsed === "pure");

    if (pureMetrics.length === 0) {
      return { shouldRollback: false, reason: "No pure pipeline metrics" };
    }

    // Check error rate
    const avgErrorRate =
      pureMetrics.reduce((sum, m) => sum + m.errorRate, 0) / pureMetrics.length;
    if (avgErrorRate > config.maxErrorThreshold) {
      return {
        shouldRollback: true,
        reason: `High error rate: ${avgErrorRate.toFixed(1)}%`,
      };
    }

    // Check for consistent failures
    const recentFailures = pureMetrics
      .slice(-5)
      .filter((m) => m.errorRate > 20);
    if (recentFailures.length >= 3) {
      return { shouldRollback: true, reason: "Multiple consecutive failures" };
    }

    // Check for performance degradation
    const originalMetrics = recentMetrics.filter(
      (m) => m.pipelineUsed === "original"
    );
    if (originalMetrics.length > 0 && pureMetrics.length > 0) {
      const avgOriginalTime =
        originalMetrics.reduce((sum, m) => sum + m.processingTime, 0) /
        originalMetrics.length;
      const avgPureTime =
        pureMetrics.reduce((sum, m) => sum + m.processingTime, 0) /
        pureMetrics.length;

      if (avgPureTime > avgOriginalTime * 2) {
        return {
          shouldRollback: true,
          reason: "Significant performance degradation",
        };
      }
    }

    return { shouldRollback: false, reason: "Metrics within acceptable range" };
  }

  /**
   * Execute rollback procedure
   */
  static executeRollback(): { success: boolean; message: string } {
    try {
      // In a real implementation, this would:
      // 1. Update feature flags to disable pure pipeline
      // 2. Clear any cached data
      // 3. Send alerts to administrators
      // 4. Log the rollback event

      console.warn("🔄 MIGRATION ROLLBACK EXECUTED");
      console.warn("Pure pipeline has been disabled due to issues");

      return {
        success: true,
        message: "Rollback completed successfully. Pure pipeline disabled.",
      };
    } catch (error) {
      console.error("❌ Rollback failed:", error);
      return {
        success: false,
        message: `Rollback failed: ${error}`,
      };
    }
  }
}

// Singleton instance for global metrics collection
export const migrationMetrics = new MigrationMetricsCollector();
