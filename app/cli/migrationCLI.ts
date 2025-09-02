/**
 * Command Line Interface for managing pricing pipeline migration
 * Usage: node migration-cli.js [command] [options]
 */

import {
  migrationMetrics,
  MigrationValidator,
  MigrationRollback,
} from "../utils/migrationUtils";
import {
  getMigrationConfig,
  getCurrentMigrationPhase,
} from "../config/migrationConfig";

interface CliOptions {
  format?: "json" | "csv" | "table";
  days?: number;
  verbose?: boolean;
}

/**
 * Migration CLI commands
 */
export class MigrationCLI {
  /**
   * Show current migration status
   */
  static showStatus(options: CliOptions = {}) {
    const config = getMigrationConfig();
    const phase = getCurrentMigrationPhase();
    const status = migrationMetrics.getCurrentStatus();

    const statusInfo = {
      "Migration Phase": phase,
      "Pure Pipeline Enabled": config.enablePurePipeline,
      "Parallel Testing": config.enableParallelTesting,
      "Auto Rollback": config.enableAutoRollback,
      "Total Executions": status.totalExecutions,
      "Recent Pure Usage": status.purePipelineUsage,
      "Recent Original Usage": status.originalPipelineUsage,
      "Avg Processing Time": `${status.averageProcessingTime.toFixed(0)}ms`,
      "Avg Error Rate": `${status.averageErrorRate.toFixed(1)}%`,
    };

    if (options.format === "json") {
      console.log(JSON.stringify(statusInfo, null, 2));
    } else {
      console.log("\n📊 PRICING PIPELINE MIGRATION STATUS");
      console.log("=====================================");
      Object.entries(statusInfo).forEach(([key, value]) => {
        console.log(`${key.padEnd(25)}: ${value}`);
      });
      console.log("");
    }
  }

  /**
   * Generate detailed migration report
   */
  static generateReport(options: CliOptions = {}) {
    const days = options.days || 7;
    const report = migrationMetrics.generateReport(days);

    console.log(`\n📈 MIGRATION REPORT (Last ${days} days)`);
    console.log("=====================================");

    console.log(`Total Executions: ${report.summary.totalExecutions}`);
    console.log(`Pure Pipeline Success: ${report.summary.pureSuccess}`);
    console.log(`Original Pipeline Success: ${report.summary.originalSuccess}`);
    console.log(
      `Performance Gain: ${report.summary.performanceGain.toFixed(1)}%`
    );
    console.log(
      `Error Reduction: ${report.summary.errorReduction.toFixed(1)}%`
    );
    console.log(
      `Recommendation: ${report.summary.recommendation.toUpperCase()}`
    );

    if (options.verbose) {
      console.log("\nDetailed Metrics:");
      report.metrics.slice(-10).forEach((metric) => {
        console.log(
          `${metric.timestamp.toISOString()}: ${metric.pipelineUsed} - ${
            metric.totalSkus
          } SKUs, ${metric.errorRate.toFixed(1)}% errors, ${
            metric.processingTime
          }ms`
        );
      });
    }

    this.provideRecommendations(report.summary.recommendation);
  }

  /**
   * Export metrics data
   */
  static exportMetrics(options: CliOptions = {}) {
    const format =
      options.format === "table" ? "json" : options.format || "json";
    const data = migrationMetrics.exportMetrics(format as "json" | "csv");

    const filename = `migration-metrics-${
      new Date().toISOString().split("T")[0]
    }.${format}`;

    // In a real implementation, this would write to file
    console.log(`\n📁 Exporting metrics to ${filename}`);
    console.log("Data:");
    console.log(data.substring(0, 500) + (data.length > 500 ? "..." : ""));
  }

  /**
   * Validate current pipeline state
   */
  static validatePipeline() {
    console.log("\n🔍 VALIDATING PIPELINE STATE");
    console.log("============================");

    const config = getMigrationConfig();
    const status = migrationMetrics.getCurrentStatus();

    // Basic configuration validation
    const issues: string[] = [];

    if (
      config.enablePurePipeline &&
      !config.enableParallelTesting &&
      getCurrentMigrationPhase() === "testing"
    ) {
      issues.push(
        "Pure pipeline enabled without parallel testing in testing phase"
      );
    }

    if (config.maxErrorThreshold > 10) {
      issues.push("Error threshold too high for production use");
    }

    if (status.averageErrorRate > config.maxErrorThreshold) {
      issues.push(
        `Current error rate (${status.averageErrorRate.toFixed(
          1
        )}%) exceeds threshold`
      );
    }

    if (issues.length === 0) {
      console.log("✅ Pipeline configuration is valid");
    } else {
      console.log("⚠️  Validation Issues Found:");
      issues.forEach((issue) => console.log(`   - ${issue}`));
    }

    // Check if rollback is recommended
    const recentMetrics = migrationMetrics["metrics"].slice(-20);
    const rollbackCheck = MigrationRollback.shouldRollback(recentMetrics);

    if (rollbackCheck.shouldRollback) {
      console.log(`\n🚨 ROLLBACK RECOMMENDED: ${rollbackCheck.reason}`);
    } else {
      console.log(`\n✅ Pipeline stable: ${rollbackCheck.reason}`);
    }
  }

  /**
   * Execute migration rollback
   */
  static executeRollback(force: boolean = false) {
    console.log("\n🔄 MIGRATION ROLLBACK");
    console.log("====================");

    if (!force) {
      console.log(
        "This will disable the pure pipeline and revert to the original implementation."
      );
      console.log("Use --force flag to confirm rollback execution.");
      return;
    }

    const result = MigrationRollback.executeRollback();

    if (result.success) {
      console.log("✅ Rollback completed successfully");
      console.log(result.message);
    } else {
      console.log("❌ Rollback failed");
      console.log(result.message);
    }
  }

  /**
   * Provide recommendations based on current state
   */
  private static provideRecommendations(recommendation: string) {
    console.log("\n💡 RECOMMENDATIONS");
    console.log("==================");

    switch (recommendation) {
      case "continue_testing":
        console.log("- Continue parallel testing for more data");
        console.log("- Monitor error rates closely");
        console.log("- Consider increasing test coverage");
        break;

      case "rollout_gradual":
        console.log("- Begin gradual rollout to more users");
        console.log("- Set up monitoring alerts");
        console.log("- Prepare rollback procedures");
        break;

      case "rollout_full":
        console.log("- Consider full rollout to all users");
        console.log("- Disable parallel testing to save resources");
        console.log("- Plan removal of old pipeline code");
        break;

      case "rollback":
        console.log("🚨 IMMEDIATE ACTION REQUIRED");
        console.log("- Execute rollback immediately");
        console.log("- Investigate issues with pure pipeline");
        console.log("- Review recent changes");
        break;

      default:
        console.log("- Continue monitoring");
        console.log("- Review metrics regularly");
    }
  }

  /**
   * Interactive monitoring mode
   */
  static startMonitoring(intervalSeconds: number = 60) {
    console.log(
      `\n👁️  STARTING CONTINUOUS MONITORING (${intervalSeconds}s intervals)`
    );
    console.log("Press Ctrl+C to stop");
    console.log("=====================================================");

    const displayStatus = () => {
      console.clear();
      console.log(
        `🕐 ${new Date().toLocaleTimeString()} - Migration Monitoring`
      );
      this.showStatus({ format: "table" });

      // Check for issues
      const recentMetrics = migrationMetrics["metrics"].slice(-5);
      const rollbackCheck = MigrationRollback.shouldRollback(recentMetrics);

      if (rollbackCheck.shouldRollback) {
        console.log(`\n🚨 ALERT: ${rollbackCheck.reason}`);
      }
    };

    // Initial display
    displayStatus();

    // Set up interval
    const interval = setInterval(displayStatus, intervalSeconds * 1000);

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log("\n\n👋 Monitoring stopped");
      process.exit(0);
    });
  }
}

/**
 * Parse command line arguments and execute appropriate command
 */
export function runMigrationCLI() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Parse options
  const options: CliOptions = {};
  let force = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--format" && i + 1 < args.length) {
      options.format = args[++i] as "json" | "csv" | "table";
    } else if (arg === "--days" && i + 1 < args.length) {
      options.days = parseInt(args[++i]);
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--force") {
      force = true;
    }
  }

  switch (command) {
    case "status":
      MigrationCLI.showStatus(options);
      break;

    case "report":
      MigrationCLI.generateReport(options);
      break;

    case "export":
      MigrationCLI.exportMetrics(options);
      break;

    case "validate":
      MigrationCLI.validatePipeline();
      break;

    case "rollback":
      MigrationCLI.executeRollback(force);
      break;

    case "monitor":
      const interval = options.days || 60; // Reuse days option for interval
      MigrationCLI.startMonitoring(interval);
      break;

    default:
      console.log("\n🔧 PRICING PIPELINE MIGRATION CLI");
      console.log("==================================");
      console.log("Available commands:");
      console.log("  status           Show current migration status");
      console.log("  report [--days N] [--verbose]  Generate migration report");
      console.log("  export [--format json|csv]    Export metrics data");
      console.log("  validate         Validate pipeline configuration");
      console.log("  rollback [--force]            Execute migration rollback");
      console.log(
        "  monitor [--days interval]     Start continuous monitoring"
      );
      console.log("\nOptions:");
      console.log("  --format json|csv|table       Output format");
      console.log("  --days N                      Number of days for report");
      console.log("  --verbose                     Show detailed information");
      console.log("  --force                       Force rollback execution");
      console.log("");
  }
}

// Run CLI if this file is executed directly
if (require.main === module) {
  runMigrationCLI();
}
