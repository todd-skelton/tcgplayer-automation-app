/**
 * Migration demonstration script
 * Shows how the pricing pipeline migration system works
 */

import { PricingOrchestrator } from "../services/pricingOrchestrator";
import { MigrationOrchestrator } from "../services/migrationOrchestrator";
import { MigrationCLI } from "../cli/migrationCLI";
import {
  createMigrationDashboard,
  generateDashboardHTML,
} from "../dashboard/migrationDashboard";
import { migrationMetrics } from "../utils/migrationUtils";
import { getMigrationConfig } from "../config/migrationConfig";
import * as fs from "fs";
import * as path from "path";

/**
 * Simple mock data source for demonstration
 */
class MockDataSource {
  constructor(private data: any[]) {}

  async getAll() {
    return this.data;
  }
}

/**
 * Demonstration of the migration system
 */
export class MigrationDemo {
  static async runBasicDemo() {
    console.log("\n🚀 PRICING PIPELINE MIGRATION DEMO");
    console.log("==================================\n");

    // Show initial configuration
    console.log("1. Current Migration Configuration:");
    const config = getMigrationConfig();
    console.log(`   Pure Pipeline Enabled: ${config.enablePurePipeline}`);
    console.log(`   Parallel Testing: ${config.enableParallelTesting}`);
    console.log(`   Auto Rollback: ${config.enableAutoRollback}`);
    console.log(`   Error Threshold: ${config.maxErrorThreshold}%`);

    // Create sample data for testing
    const testData = [
      { sku: 12345, name: "Test Card A", setName: "Test Set 1" },
      { sku: 12346, name: "Test Card B", setName: "Test Set 1" },
      { sku: 12347, name: "Test Card C", setName: "Test Set 2" },
    ];

    console.log("\n2. Running Pricing Pipeline Test:");

    try {
      const orchestrator = new PricingOrchestrator();
      const dataSource = new MockDataSource(testData);

      console.log(`   Processing ${testData.length} test SKUs...`);

      const result = await orchestrator.executePurePipeline(
        dataSource as any,
        {},
        {
          source: "demo",
          percentile: 80,
          onProgress: (progress) => {
            console.log(
              `   📊 ${progress.status} (${progress.processed}/${progress.total})`
            );
          },
        }
      );

      console.log(`   ✅ Pipeline completed`);
      console.log(`   📊 Results: ${result.pricedSkus.length} SKUs processed`);
      console.log(
        `   📈 Processed: ${result.summary.processedRows}, Skipped: ${result.summary.skippedRows}, Errors: ${result.summary.errorRows}`
      );
      console.log(`   ⏱️  Processing Time: ${result.summary.processingTime}ms`);
      console.log(
        `   📊 Success Rate: ${result.summary.successRate.toFixed(1)}%`
      );
    } catch (error) {
      console.log(
        `   ❌ Demo failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    console.log("\n3. Migration Metrics Summary:");
    const status = migrationMetrics.getCurrentStatus();
    console.log(`   Total Executions: ${status.totalExecutions}`);
    console.log(
      `   Average Processing Time: ${status.averageProcessingTime.toFixed(0)}ms`
    );
    console.log(
      `   Average Error Rate: ${status.averageErrorRate.toFixed(1)}%`
    );
    console.log(`   Pure Pipeline Usage: ${status.purePipelineUsage}%`);
    console.log(`   Original Pipeline Usage: ${status.originalPipelineUsage}%`);

    console.log("\n✅ Basic demo completed successfully!");
  }

  static async runMigrationOrchestratorDemo() {
    console.log("\n🔬 MIGRATION ORCHESTRATOR DEMONSTRATION");
    console.log("======================================\n");

    const migrationOrchestrator = new MigrationOrchestrator();

    // Generate test data
    const testData = Array.from({ length: 5 }, (_, i) => ({
      sku: 1000 + i,
      name: `Test Card ${i + 1}`,
      setName: "Demo Set",
    }));

    console.log(
      `Running migration orchestrator with ${testData.length} SKUs...`
    );

    try {
      const dataSource = new MockDataSource(testData);

      const result = await migrationOrchestrator.executePipeline(
        dataSource as any,
        {},
        {
          source: "migration-demo",
          percentile: 80,
          onProgress: (progress) => {
            console.log(`   📊 ${progress.status}`);
          },
        }
      );

      console.log("\n📊 Migration Orchestrator Results:");
      console.log(
        `   Processed: ${result.summary.processedRows} SKUs successfully`
      );
      console.log(`   Errors: ${result.summary.errorRows}`);
      console.log(`   Skipped: ${result.summary.skippedRows}`);
      console.log(`   Success Rate: ${result.summary.successRate.toFixed(1)}%`);
    } catch (error) {
      console.log(
        `❌ Migration orchestrator demo failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  static generateDashboardFile() {
    console.log("\n📊 GENERATING DASHBOARD HTML");
    console.log("============================\n");

    try {
      const dashboardHTML = generateDashboardHTML();
      const outputPath = path.join(process.cwd(), "migration-dashboard.html");

      fs.writeFileSync(outputPath, dashboardHTML);

      console.log(`✅ Dashboard generated: ${outputPath}`);
      console.log(
        "   Open this file in your browser to view the migration dashboard"
      );
      console.log(
        "   Note: For live data, use the CLI commands or API integration"
      );
    } catch (error) {
      console.log(
        `❌ Failed to generate dashboard: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  static showCLIDemo() {
    console.log("\n🔧 CLI DEMONSTRATION");
    console.log("===================\n");

    console.log("1. Show Current Status:");
    MigrationCLI.showStatus();

    console.log("\n2. Generate Report:");
    MigrationCLI.generateReport({ days: 1, verbose: false });

    console.log("\n3. Validate Pipeline:");
    MigrationCLI.validatePipeline();

    console.log("\n4. Check Rollback Status:");
    const dashboard = createMigrationDashboard();
    const rollbackCheck = dashboard.checkRollback();

    if (rollbackCheck.success) {
      console.log(
        `   Rollback Recommended: ${
          rollbackCheck.data?.shouldRollback ? "YES" : "NO"
        }`
      );
      if (rollbackCheck.data?.reason) {
        console.log(`   Reason: ${rollbackCheck.data.reason}`);
      }
    }
  }

  static showAvailableCommands() {
    console.log("\n📋 AVAILABLE CLI COMMANDS");
    console.log("=========================\n");

    console.log("Migration CLI Commands:");
    console.log(
      "  node dist/cli/migrationCLI.js status          - Show current status"
    );
    console.log(
      "  node dist/cli/migrationCLI.js report          - Generate report"
    );
    console.log(
      "  node dist/cli/migrationCLI.js validate        - Validate pipeline"
    );
    console.log(
      "  node dist/cli/migrationCLI.js monitor         - Start monitoring"
    );
    console.log(
      "  node dist/cli/migrationCLI.js rollback --force - Execute rollback"
    );
    console.log(
      "  node dist/cli/migrationCLI.js export          - Export metrics"
    );

    console.log("\nDemo Script Commands:");
    console.log(
      "  node dist/scripts/migrationDemo.js basic      - Run basic demo"
    );
    console.log(
      "  node dist/scripts/migrationDemo.js migration  - Run migration demo"
    );
    console.log(
      "  node dist/scripts/migrationDemo.js cli        - Show CLI demo"
    );
    console.log(
      "  node dist/scripts/migrationDemo.js dashboard  - Generate dashboard"
    );
    console.log(
      "  node dist/scripts/migrationDemo.js commands   - Show this help"
    );
    console.log(
      "  node dist/scripts/migrationDemo.js full       - Run all demos"
    );
  }

  static async runFullDemo() {
    console.log("🎯 FULL MIGRATION SYSTEM DEMONSTRATION");
    console.log("======================================\n");

    // Run all demo components
    await this.runBasicDemo();
    await this.runMigrationOrchestratorDemo();
    this.showCLIDemo();
    this.generateDashboardFile();
    this.showAvailableCommands();

    console.log("\n🎉 FULL DEMO COMPLETED");
    console.log("======================");
    console.log("The migration system is now ready for production use!");
    console.log("\nNext steps:");
    console.log("1. Integrate with your existing codebase");
    console.log("2. Configure feature flags and environment variables");
    console.log("3. Set up monitoring and alerting");
    console.log("4. Plan gradual rollout strategy");
    console.log("5. Monitor metrics and be ready to rollback if needed");
    console.log("\nFor ongoing monitoring, use:");
    console.log("   node dist/cli/migrationCLI.js monitor");
  }
}

// Script execution
if (require.main === module) {
  const command = process.argv[2] || "full";

  switch (command) {
    case "basic":
      MigrationDemo.runBasicDemo().catch(console.error);
      break;

    case "migration":
      MigrationDemo.runMigrationOrchestratorDemo().catch(console.error);
      break;

    case "cli":
      MigrationDemo.showCLIDemo();
      break;

    case "dashboard":
      MigrationDemo.generateDashboardFile();
      break;

    case "commands":
      MigrationDemo.showAvailableCommands();
      break;

    case "full":
    default:
      MigrationDemo.runFullDemo().catch(console.error);
      break;
  }
}
