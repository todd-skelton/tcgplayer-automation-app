/**
 * Dashboard for real-time migration monitoring
 * Provides web interface for migration metrics and controls
 */

import {
  migrationMetrics,
  MigrationValidator,
  MigrationRollback,
} from "../utils/migrationUtils";
import {
  getMigrationConfig,
  getCurrentMigrationPhase,
  updateMigrationConfig,
} from "../config/migrationConfig";

/**
 * Simple HTTP server for migration dashboard (without Express dependency)
 */
export class MigrationDashboardServer {
  private port: number;

  constructor(port: number = 3001) {
    this.port = port;
  }

  /**
   * Get current migration status
   */
  getStatus() {
    try {
      const config = getMigrationConfig();
      const phase = getCurrentMigrationPhase();
      const status = migrationMetrics.getCurrentStatus();

      return {
        success: true,
        data: {
          phase,
          config,
          status,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to get migration status",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get migration metrics
   */
  getMetrics(days: number = 7) {
    try {
      const report = migrationMetrics.generateReport(days);

      return {
        success: true,
        data: report,
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to get migration metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get real-time metrics for dashboard charts
   */
  getRealTimeMetrics(limit: number = 100) {
    try {
      const metrics = migrationMetrics["metrics"].slice(-limit);

      return {
        success: true,
        data: {
          metrics,
          summary: migrationMetrics.getCurrentStatus(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to get real-time metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Update migration configuration
   */
  updateConfig(updates: {
    enablePurePipeline?: boolean;
    enableParallelTesting?: boolean;
    purePipelinePercentage?: number;
  }) {
    try {
      // Validate input
      if (
        updates.enablePurePipeline !== undefined &&
        typeof updates.enablePurePipeline !== "boolean"
      ) {
        return { success: false, error: "enablePurePipeline must be boolean" };
      }

      if (
        updates.enableParallelTesting !== undefined &&
        typeof updates.enableParallelTesting !== "boolean"
      ) {
        return {
          success: false,
          error: "enableParallelTesting must be boolean",
        };
      }

      if (
        updates.purePipelinePercentage !== undefined &&
        (typeof updates.purePipelinePercentage !== "number" ||
          updates.purePipelinePercentage < 0 ||
          updates.purePipelinePercentage > 100)
      ) {
        return {
          success: false,
          error: "purePipelinePercentage must be number between 0-100",
        };
      }

      const config = updateMigrationConfig(updates);

      return {
        success: true,
        data: config,
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to update configuration",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute rollback
   */
  executeRollback() {
    try {
      const result = MigrationRollback.executeRollback();

      return {
        success: result.success,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to execute rollback",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check if rollback is recommended
   */
  checkRollback() {
    try {
      const recentMetrics = migrationMetrics["metrics"].slice(-20);
      const rollbackCheck = MigrationRollback.shouldRollback(recentMetrics);

      return {
        success: true,
        data: rollbackCheck,
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to check rollback status",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Validate pipeline configuration
   */
  validatePipeline() {
    try {
      const config = getMigrationConfig();
      const status = migrationMetrics.getCurrentStatus();
      const phase = getCurrentMigrationPhase();

      const issues: string[] = [];
      const warnings: string[] = [];

      // Configuration validation
      if (
        config.enablePurePipeline &&
        !config.enableParallelTesting &&
        phase === "testing"
      ) {
        issues.push(
          "Pure pipeline enabled without parallel testing in testing phase"
        );
      }

      if (config.maxErrorThreshold > 10) {
        warnings.push("Error threshold is high for production use");
      }

      if (status.averageErrorRate > config.maxErrorThreshold) {
        issues.push(
          `Current error rate (${status.averageErrorRate.toFixed(
            1
          )}%) exceeds threshold`
        );
      }

      if (status.totalExecutions < 100 && phase === "full") {
        warnings.push("Low execution count for production phase");
      }

      return {
        success: true,
        data: {
          valid: issues.length === 0,
          issues,
          warnings,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to validate pipeline",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Export metrics
   */
  exportMetrics(format: "json" | "csv" = "json") {
    try {
      const data = migrationMetrics.exportMetrics(format);
      const filename = `migration-metrics-${
        new Date().toISOString().split("T")[0]
      }.${format}`;

      return {
        success: true,
        data: {
          content: data,
          filename,
          contentType: format === "json" ? "application/json" : "text/csv",
        },
      };
    } catch (error) {
      return {
        success: false,
        error: "Failed to export metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Generate dashboard HTML
   */
  getDashboardHTML(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pricing Pipeline Migration Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .dashboard { max-width: 1200px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .metric { display: flex; justify-content: space-between; align-items: center; margin: 10px 0; }
        .metric-value { font-weight: bold; font-size: 1.2em; }
        .status-good { color: #28a745; }
        .status-warning { color: #ffc107; }
        .status-error { color: #dc3545; }
        .button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
        .button:hover { background: #0056b3; }
        .button.danger { background: #dc3545; }
        .button.danger:hover { background: #c82333; }
        .controls { display: flex; gap: 10px; align-items: center; margin: 20px 0; flex-wrap: wrap; }
        .form-group { display: flex; flex-direction: column; gap: 5px; }
        .form-group label { font-weight: bold; }
        .form-group input, .form-group select { padding: 5px; border: 1px solid #ddd; border-radius: 4px; }
        .alert { padding: 15px; margin: 10px 0; border-radius: 4px; }
        .alert-success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
        .alert-warning { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
        .alert-danger { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        .log { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 4px; padding: 15px; margin: 10px 0; font-family: monospace; font-size: 0.9em; max-height: 200px; overflow-y: auto; }
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="header">
            <h1>🚀 Pricing Pipeline Migration Dashboard</h1>
            <p>Real-time monitoring and control for pricing pipeline migration</p>
            <p><strong>Note:</strong> This is a static dashboard. For full functionality, use the CLI tool or API endpoints.</p>
        </div>

        <div id="alerts"></div>

        <div class="cards">
            <div class="card">
                <h3>Migration Status</h3>
                <div class="metric">
                    <span>Phase:</span>
                    <span id="migration-phase" class="metric-value">-</span>
                </div>
                <div class="metric">
                    <span>Pure Pipeline:</span>
                    <span id="pure-enabled" class="metric-value">-</span>
                </div>
                <div class="metric">
                    <span>Parallel Testing:</span>
                    <span id="parallel-enabled" class="metric-value">-</span>
                </div>
                <div class="metric">
                    <span>Usage Percentage:</span>
                    <span id="usage-percentage" class="metric-value">-</span>
                </div>
            </div>

            <div class="card">
                <h3>Performance Metrics</h3>
                <div class="metric">
                    <span>Total Executions:</span>
                    <span id="total-executions" class="metric-value">-</span>
                </div>
                <div class="metric">
                    <span>Avg Processing Time:</span>
                    <span id="avg-processing-time" class="metric-value">-</span>
                </div>
                <div class="metric">
                    <span>Error Rate:</span>
                    <span id="error-rate" class="metric-value">-</span>
                </div>
                <div class="metric">
                    <span>Last Updated:</span>
                    <span id="last-updated" class="metric-value">-</span>
                </div>
            </div>

            <div class="card">
                <h3>Quick Actions</h3>
                <p>Use the CLI tool for live updates:</p>
                <div class="log">
                    <div># Check current status</div>
                    <div>node migration-cli.js status</div>
                    <div></div>
                    <div># Generate report</div>
                    <div>node migration-cli.js report --days 7 --verbose</div>
                    <div></div>
                    <div># Start monitoring</div>
                    <div>node migration-cli.js monitor</div>
                    <div></div>
                    <div># Validate pipeline</div>
                    <div>node migration-cli.js validate</div>
                    <div></div>
                    <div># Execute rollback (use with caution)</div>
                    <div>node migration-cli.js rollback --force</div>
                </div>
            </div>
        </div>

        <div class="card">
            <h3>Current Migration Status</h3>
            <div id="status-content">
                <p>Loading status...</p>
            </div>
        </div>
    </div>

    <script>
        // Load initial status
        document.addEventListener('DOMContentLoaded', function() {
            loadStatus();
        });

        function loadStatus() {
            // Since we don't have Express, we'll show static information
            document.getElementById('migration-phase').textContent = 'Static View';
            document.getElementById('pure-enabled').textContent = 'See CLI';
            document.getElementById('parallel-enabled').textContent = 'See CLI';
            document.getElementById('usage-percentage').textContent = 'See CLI';
            document.getElementById('total-executions').textContent = 'See CLI';
            document.getElementById('avg-processing-time').textContent = 'See CLI';
            document.getElementById('error-rate').textContent = 'See CLI';
            document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();

            document.getElementById('status-content').innerHTML = \`
                <p><strong>Dashboard Mode:</strong> Static HTML view</p>
                <p><strong>For Real-time Data:</strong> Use the CLI commands shown above</p>
                <p><strong>API Mode:</strong> Integrate with your existing web server</p>
                <div class="alert alert-warning">
                    This dashboard shows the structure but requires the CLI tool or API integration for live data.
                </div>
            \`;
        }
    </script>
</body>
</html>
    `;
  }

  /**
   * Simple CLI-style status display
   */
  displayStatus() {
    const status = this.getStatus();

    if (status.success && status.data) {
      console.log("\n📊 PRICING PIPELINE MIGRATION STATUS");
      console.log("=====================================");
      console.log(`Migration Phase       : ${status.data.phase}`);
      console.log(
        `Pure Pipeline Enabled : ${status.data.config.enablePurePipeline}`
      );
      console.log(
        `Parallel Testing      : ${status.data.config.enableParallelTesting}`
      );
      console.log(
        `Total Executions      : ${status.data.status.totalExecutions}`
      );
      console.log(
        `Avg Processing Time   : ${status.data.status.averageProcessingTime.toFixed(
          0
        )}ms`
      );
      console.log(
        `Avg Error Rate        : ${status.data.status.averageErrorRate.toFixed(
          1
        )}%`
      );
      console.log(`Last Updated          : ${status.data.timestamp}`);
      console.log("");
    } else {
      console.log("❌ Failed to get status:", status.error);
    }
  }
}

/**
 * Create and configure migration dashboard
 */
export function createMigrationDashboard(
  port: number = 3001
): MigrationDashboardServer {
  return new MigrationDashboardServer(port);
}

/**
 * Generate static dashboard HTML file
 */
export function generateDashboardHTML(): string {
  const dashboard = new MigrationDashboardServer();
  return dashboard.getDashboardHTML();
}

export default MigrationDashboardServer;
