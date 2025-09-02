# Pricing Pipeline Migration System

## Overview

This migration system facilitates the transition from the original pricing pipeline to a new pure data-driven pipeline. The system supports parallel testing, gradual rollout, metrics collection, and automatic rollback capabilities.

## Architecture

### Core Components

1. **Pure Pipeline** (`app/services/purePricingService.ts`)

   - Pure functions with no external dependencies
   - Batch data gathering upfront
   - Improved testability and performance

2. **Data Gathering Service** (`app/services/pricingDataGatheringService.ts`)

   - Collects all required data before pricing
   - Batched operations for efficiency
   - Separated from pricing logic

3. **Migration Orchestrator** (`app/services/migrationOrchestrator.ts`)

   - Routes between old and new pipelines
   - Parallel testing and comparison
   - Result validation

4. **Migration Utilities** (`app/utils/migrationUtils.ts`)
   - Metrics collection and analysis
   - Validation and rollback logic
   - Performance monitoring

### Management Tools

1. **CLI Tool** (`app/cli/migrationCLI.ts`)

   - Status monitoring
   - Report generation
   - Manual rollback control
   - Export capabilities

2. **Dashboard** (`app/dashboard/migrationDashboard.ts`)

   - Visual monitoring interface
   - Real-time metrics
   - Configuration management

3. **Demo System** (`app/scripts/migrationDemo.ts`)
   - End-to-end testing
   - System validation
   - Documentation examples

## Migration Phases

### Phase 1: Testing (Current)

- Parallel testing enabled
- Pure pipeline disabled for users
- Collect comparison metrics
- Validate results

### Phase 2: Canary

- 5% of users use pure pipeline
- Monitor error rates
- Compare performance
- Ready for rollback

### Phase 3: Gradual

- 50% of users use pure pipeline
- Monitor stability
- Performance validation
- Scale testing

### Phase 4: Full

- All users use pure pipeline
- Monitor production metrics
- Prepare for old pipeline removal

## Quick Start

### 1. Run Basic Demo

```bash
npm run build
node dist/scripts/migrationDemo.js basic
```

### 2. Check Migration Status

```bash
node dist/cli/migrationCLI.js status
```

### 3. Generate Report

```bash
node dist/cli/migrationCLI.js report --days 7 --verbose
```

### 4. Start Monitoring

```bash
node dist/cli/migrationCLI.js monitor
```

### 5. Generate Dashboard

```bash
node dist/scripts/migrationDemo.js dashboard
# Open migration-dashboard.html in browser
```

## Configuration

### Environment Variables

```typescript
NODE_ENV = development; // Enables parallel testing
MIGRATION_PHASE = testing; // Controls pipeline selection
PURE_PIPELINE_ENABLED = false; // Feature flag
PARALLEL_TESTING_ENABLED = true; // Comparison testing
```

### Feature Flags

Located in `app/config/migrationConfig.ts`:

```typescript
{
  enablePurePipeline: false,
  enableParallelTesting: true,
  maxConcurrentDataFetches: 10,
  enableDataCaching: true,
  enableDetailedLogging: false,
  validateResultsAgainstOldPipeline: true,
  enableAutoRollback: true,
  maxErrorThreshold: 5  // 5% error threshold
}
```

## Monitoring and Metrics

### Key Metrics

- **Processing Time**: Pipeline execution duration
- **Error Rate**: Percentage of failed operations
- **Result Accuracy**: Comparison between pipelines
- **Resource Usage**: Memory and CPU utilization

### Monitoring Commands

```bash
# Show current status
node dist/cli/migrationCLI.js status

# Generate detailed report
node dist/cli/migrationCLI.js report --days 30

# Validate configuration
node dist/cli/migrationCLI.js validate

# Export metrics
node dist/cli/migrationCLI.js export --format csv

# Start real-time monitoring
node dist/cli/migrationCLI.js monitor
```

## Rollback Procedures

### Automatic Rollback

Triggers when:

- Error rate exceeds threshold (default 5%)
- Performance degradation > 50%
- 3 consecutive failures
- Manual trigger

### Manual Rollback

```bash
# Check if rollback is recommended
node dist/cli/migrationCLI.js validate

# Execute rollback (with confirmation)
node dist/cli/migrationCLI.js rollback --force
```

## Integration Guide

### 1. Replace Existing Pipeline Calls

```typescript
// Before
const result = await pricingCalculator.calculate(skus);

// After
const orchestrator = new MigrationOrchestrator();
const result = await orchestrator.executePipeline(dataSource, params, config);
```

### 2. Add Metrics Collection

```typescript
import { migrationMetrics } from "./utils/migrationUtils";

// Automatic metrics collection is handled by the orchestrator
// Manual metrics can be added:
migrationMetrics.recordExecution({
  pipelineUsed: "pure",
  processingTime: 1500,
  totalSkus: 100,
  errorRate: 0,
  timestamp: new Date(),
});
```

### 3. Configure Feature Flags

```typescript
import {
  getMigrationConfig,
  updateMigrationConfig,
} from "./config/migrationConfig";

// Check current config
const config = getMigrationConfig();

// Update configuration
updateMigrationConfig({
  enablePurePipeline: true,
  purePipelinePercentage: 10, // 10% of users
});
```

## Testing

### Unit Tests

```bash
# Test pure pricing logic
npm test -- purePricingService

# Test data gathering
npm test -- pricingDataGatheringService

# Test migration orchestrator
npm test -- migrationOrchestrator
```

### Integration Tests

```bash
# Run full migration demo
node dist/scripts/migrationDemo.js full

# Test parallel execution
node dist/scripts/migrationDemo.js migration

# Validate CLI functionality
node dist/scripts/migrationDemo.js cli
```

## Troubleshooting

### Common Issues

1. **High Error Rate**

   - Check data source connectivity
   - Validate input data format
   - Review recent configuration changes

2. **Performance Degradation**

   - Monitor concurrent fetch limits
   - Check database connection pool
   - Review caching configuration

3. **Result Discrepancies**
   - Compare algorithm implementations
   - Validate data transformation logic
   - Check rounding and precision settings

### Debug Commands

```bash
# Enable detailed logging
NODE_ENV=development node dist/scripts/migrationDemo.js basic

# Generate verbose report
node dist/cli/migrationCLI.js report --days 1 --verbose

# Export detailed metrics
node dist/cli/migrationCLI.js export --format json
```

## Production Deployment

### Pre-deployment Checklist

- [ ] All tests passing
- [ ] Migration config validated
- [ ] Monitoring alerts configured
- [ ] Rollback procedures tested
- [ ] Team trained on CLI tools

### Deployment Steps

1. Deploy with pure pipeline disabled
2. Enable parallel testing
3. Monitor for 24-48 hours
4. Gradually increase pure pipeline percentage
5. Monitor metrics at each step
6. Full rollout after validation

### Post-deployment

- Monitor error rates daily
- Generate weekly migration reports
- Review performance metrics
- Plan old pipeline removal

## Support

For issues or questions:

1. Check the troubleshooting guide above
2. Review migration metrics and logs
3. Use CLI validation tools
4. Contact the development team

## Files and Structure

```
app/
├── config/
│   └── migrationConfig.ts          # Feature flags and configuration
├── services/
│   ├── pricingDataGatheringService.ts  # Pure data gathering
│   ├── purePricingService.ts           # Pure pricing logic
│   ├── migrationOrchestrator.ts        # Pipeline orchestration
│   └── pricingOrchestrator.ts          # Updated orchestrator
├── utils/
│   └── migrationUtils.ts               # Metrics and validation
├── cli/
│   └── migrationCLI.ts                 # Command line interface
├── dashboard/
│   └── migrationDashboard.ts           # Web dashboard
├── scripts/
│   └── migrationDemo.ts                # Demo and testing
└── types/
    └── pricingData.ts                  # Pure data structures
```

This migration system provides a robust, observable, and reversible way to transition to the new pure pricing pipeline while maintaining system stability and data integrity.
