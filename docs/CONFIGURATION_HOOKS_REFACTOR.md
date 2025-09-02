# Configuration Hooks Refactor

This document outlines the refactoring of the configuration system from a single, complex hook with one localStorage key to individual, focused hooks with separate localStorage keys for each configuration type.

## Overview

The configuration system has been refactored to be more modular and maintainable by breaking it into individual hooks, each responsible for a specific configuration area.

## New Hook Structure

### Individual Configuration Hooks

Each configuration type now has its own dedicated hook with separate localStorage persistence:

- **`usePricingConfig()`** - Manages pricing-related configuration

  - localStorage key: `"tcgplayer-pricing-config"`
  - Handles: percentiles, thresholds, min price calculations

- **`useSupplyAnalysisConfig()`** - Manages supply analysis configuration

  - localStorage key: `"tcgplayer-supply-analysis-config"`
  - Handles: enable/disable supply analysis, confidence weights, listing limits

- **`useFileConfig()`** - Manages file handling configuration

  - localStorage key: `"tcgplayer-file-config"`
  - Handles: file accept types, output prefixes, MIME types

- **`useFormDefaults()`** - Manages form default values
  - localStorage key: `"tcgplayer-form-defaults"`
  - Handles: default percentile, seller keys

### Composite Hook for Backward Compatibility

The original `useConfiguration()` hook remains available and now provides a composite view of all individual configurations:

```typescript
export function useConfiguration() {
  const pricingConfig = usePricingConfig();
  const supplyAnalysisConfig = useSupplyAnalysisConfig();
  const fileConfig = useFileConfig();
  const formDefaults = useFormDefaults();

  return {
    // Individual configs
    pricing: pricingConfig,
    supplyAnalysis: supplyAnalysisConfig,
    file: fileConfig,
    formDefaults: formDefaults,

    // Combined config object for backward compatibility
    config: {
      pricing: pricingConfig.config,
      supplyAnalysis: supplyAnalysisConfig.config,
      file: fileConfig.config,
      formDefaults: formDefaults.config,
    },

    // Individual update functions (for backward compatibility)
    updatePricingConfig: pricingConfig.updateConfig,
    updateSupplyAnalysisConfig: supplyAnalysisConfig.updateConfig,
    updateFileConfig: fileConfig.updateConfig,
    updateFormDefaults: formDefaults.updateConfig,

    // Reset all configurations
    resetToDefaults: resetAllToDefaults,

    // Computed values
    percentiles: pricingConfig.percentiles,

    // Backward compatibility helpers
    PRICING_CONSTANTS: pricingConfig.config,
    FILE_CONFIG: fileConfig.config,
  };
}
```

## Benefits

### 1. **Separation of Concerns**

Each hook is responsible for one specific configuration area, making code more focused and easier to understand.

### 2. **Performance Optimization**

Components can now import only the configuration hooks they need, reducing unnecessary re-renders when unrelated configuration changes occur.

### 3. **Independent Storage**

Each configuration type has its own localStorage key, making it easier to:

- Debug configuration issues
- Migrate or reset specific configuration areas
- Handle versioning of different configuration types independently

### 4. **Simpler Migration Logic**

No complex migration logic needed since each hook uses `useLocalStorageState` with proper defaults.

### 5. **Backward Compatibility**

Existing code continues to work unchanged through the composite `useConfiguration` hook.

## Usage Examples

### Using Individual Hooks (Recommended for new code)

```typescript
// Component that only needs form defaults
import { useFormDefaults } from "../hooks/useConfiguration";

function MyComponent() {
  const formDefaults = useFormDefaults();

  return (
    <div>
      <span>Default Percentile: {formDefaults.config.percentile}%</span>
      <button onClick={() => formDefaults.updateConfig({ percentile: 75 })}>
        Update to 75%
      </button>
    </div>
  );
}

// Component that needs pricing and supply analysis config
import {
  usePricingConfig,
  useSupplyAnalysisConfig,
} from "../hooks/useConfiguration";

function PricingComponent() {
  const pricingConfig = usePricingConfig();
  const supplyAnalysisConfig = useSupplyAnalysisConfig();

  return (
    <div>
      <span>Min Percentile: {pricingConfig.config.minPercentile}</span>
      <span>
        Supply Analysis:{" "}
        {supplyAnalysisConfig.config.enableSupplyAnalysis ? "On" : "Off"}
      </span>
    </div>
  );
}
```

### Using Composite Hook (Backward compatibility)

```typescript
// Existing code continues to work unchanged
import { useConfiguration } from "../hooks/useConfiguration";

function ExistingComponent() {
  const { config, updatePricingConfig } = useConfiguration();

  return (
    <div>
      <span>Default: {config.formDefaults.percentile}%</span>
      <button onClick={() => updatePricingConfig({ defaultPercentile: 80 })}>
        Update
      </button>
    </div>
  );
}
```

## Implementation Details

### Default Configurations

Each hook has its own default configuration object:

```typescript
const DEFAULT_PRICING_CONFIG: PricingConfig = {
  defaultPercentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
  percentileStep: PRICING_CONSTANTS.PERCENTILE_STEP,
  // ... other pricing defaults
};

const DEFAULT_SUPPLY_ANALYSIS_CONFIG: SupplyAnalysisConfig = {
  enableSupplyAnalysis: false,
  confidenceWeight: 0.7,
  maxListingsPerSku: 200,
  includeUnverifiedSellers: false,
};

// ... etc for other config types
```

### Hook Pattern

Each individual hook follows the same pattern:

```typescript
export function usePricingConfig() {
  const [config, setConfig] = useLocalStorageState<PricingConfig>(
    "tcgplayer-pricing-config",
    DEFAULT_PRICING_CONFIG
  );

  const updateConfig = (updates: Partial<PricingConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_PRICING_CONFIG);
  };

  return {
    config,
    setConfig,
    updateConfig,
    resetToDefaults,
    // Any computed values or helper functions
  };
}
```

## Migration Notes

### For Existing Users

- **No breaking changes**: Existing code continues to work unchanged
- **Automatic migration**: The `useLocalStorageState` hook automatically handles undefined values with proper defaults
- **No data loss**: Existing localStorage data remains intact and accessible through the composite hook

### For New Development

- **Prefer individual hooks**: Use specific hooks like `usePricingConfig()` instead of the composite `useConfiguration()` for better performance
- **Import only what you need**: This reduces bundle size and improves re-render performance
- **Use composite hook for configuration pages**: When you need access to all configuration types (like the configuration route)

## Files Modified

- **`app/hooks/useConfiguration.ts`**: Refactored to provide individual hooks plus composite hook
- **`app/components/QuickSettings.tsx`**: Updated to demonstrate individual hook usage
- **`app/routes/configuration.tsx`**: Continues to use composite hook for full configuration management

## Performance Impact

- **Positive**: Components using individual hooks will re-render less frequently
- **Neutral**: Components using the composite hook have the same performance as before
- **Bundle size**: Slightly larger due to additional hook exports, but tree-shaking eliminates unused hooks

## Future Enhancements

1. **Configuration validation**: Each hook could include schema validation
2. **Configuration versioning**: Individual hooks make it easier to version configuration schemas
3. **Plugin system**: Configuration could be extended with additional hooks for new features
4. **Configuration sync**: Individual hooks could sync with different storage backends
