/**
 * Migration configuration and feature flags for pricing pipeline refactoring
 */

export interface MigrationConfig {
  // Feature flags
  enablePurePipeline: boolean;
  enableParallelTesting: boolean; // Run both pipelines in parallel for comparison

  // Performance settings
  maxConcurrentDataFetches: number;
  enableDataCaching: boolean;

  // Debugging and validation
  enableDetailedLogging: boolean;
  validateResultsAgainstOldPipeline: boolean;

  // Rollback settings
  enableAutoRollback: boolean;
  maxErrorThreshold: number; // Percentage of errors before rollback
}

export const DEFAULT_MIGRATION_CONFIG: MigrationConfig = {
  enablePurePipeline: true, // Enable for testing
  enableParallelTesting: true, // Enable parallel testing for validation
  maxConcurrentDataFetches: 10,
  enableDataCaching: true,
  enableDetailedLogging: true, // Enable detailed logging for testing
  validateResultsAgainstOldPipeline: true, // Validate against old pipeline
  enableAutoRollback: true,
  maxErrorThreshold: 5, // 5% error threshold
};

/**
 * Environment-based configuration
 */
export function getMigrationConfig(): MigrationConfig {
  // In a real implementation, this would read from environment variables,
  // feature flags service, or configuration files

  const isProduction = process.env.NODE_ENV === "production";
  const isDevelopment = process.env.NODE_ENV === "development";

  if (isDevelopment) {
    return {
      ...DEFAULT_MIGRATION_CONFIG,
      enablePurePipeline: true,
      enableParallelTesting: true,
      enableDetailedLogging: true,
      validateResultsAgainstOldPipeline: true,
    };
  }

  if (isProduction) {
    return {
      ...DEFAULT_MIGRATION_CONFIG,
      enablePurePipeline: false, // Disabled in production initially
      enableAutoRollback: true,
      maxErrorThreshold: 1, // Very conservative in production
    };
  }

  // Default/test environment
  return {
    ...DEFAULT_MIGRATION_CONFIG,
    enablePurePipeline: true,
    enableDetailedLogging: true,
  };
}

/**
 * Migration phases for gradual rollout
 */
export enum MigrationPhase {
  DISABLED = "disabled",
  TESTING = "testing", // Parallel testing only
  CANARY = "canary", // Small percentage of users
  GRADUAL = "gradual", // Increasing percentage
  FULL = "full", // All users
}

export function getCurrentMigrationPhase(): MigrationPhase {
  // Enable testing phase for feature validation
  return MigrationPhase.CANARY; // Small percentage rollout for testing
}

/**
 * Determines if pure pipeline should be used based on migration phase and user
 */
export function shouldUsePurePipeline(userId?: string): boolean {
  const phase = getCurrentMigrationPhase();
  const config = getMigrationConfig();

  if (!config.enablePurePipeline) {
    return false;
  }

  switch (phase) {
    case MigrationPhase.DISABLED:
      return false;

    case MigrationPhase.TESTING:
      // Only for specific test users or development
      return process.env.NODE_ENV === "development";

    case MigrationPhase.CANARY:
      // 5% of users
      if (!userId) return false;
      return parseInt(userId) % 20 === 0;

    case MigrationPhase.GRADUAL:
      // 50% of users
      if (!userId) return false;
      return parseInt(userId) % 2 === 0;

    case MigrationPhase.FULL:
      return true;

    default:
      return false;
  }
}

/**
 * Update migration configuration
 */
export function updateMigrationConfig(
  updates: Partial<MigrationConfig>
): MigrationConfig {
  // In a real implementation, this would update the feature flags service,
  // environment variables, or configuration database

  console.log("Migration configuration update requested:", updates);

  // For now, return the merged configuration
  // This would need to be properly persisted in a real system
  const currentConfig = getMigrationConfig();

  return {
    ...currentConfig,
    ...updates,
  };
}
