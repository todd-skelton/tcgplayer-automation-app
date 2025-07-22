# Configuration Migration Fix

## Problem

Users who had existing configurations in localStorage before the supply analysis feature was added would encounter this error:

```
Cannot read properties of undefined (reading 'enableSupplyAnalysis')
```

## Root Cause

The error occurred because:

1. **Old Configuration Structure**: Existing users had configurations stored in localStorage that only contained:

   ```typescript
   {
     pricing: { ... },
     file: { ... },
     formDefaults: { ... }
     // Missing: supplyAnalysis property
   }
   ```

2. **New Code Expectation**: The new configuration UI tried to access:

   ```typescript
   config.supplyAnalysis.enableSupplyAnalysis;
   ```

3. **Undefined Access**: Since `config.supplyAnalysis` was `undefined` for existing users, accessing `enableSupplyAnalysis` threw the error.

## Solution

Implemented a migration strategy in `useConfiguration.ts`:

### Migration Function

```typescript
const migrateConfig = (storedConfig: any): AppConfiguration => {
  // If no stored config, return defaults
  if (!storedConfig) return DEFAULT_CONFIG;

  // Merge stored config with defaults to handle missing properties
  return {
    pricing: {
      ...DEFAULT_CONFIG.pricing,
      ...(storedConfig.pricing || {}),
    },
    supplyAnalysis: {
      ...DEFAULT_CONFIG.supplyAnalysis,
      ...(storedConfig.supplyAnalysis || {}), // This handles undefined
    },
    file: {
      ...DEFAULT_CONFIG.file,
      ...(storedConfig.file || {}),
    },
    formDefaults: {
      ...DEFAULT_CONFIG.formDefaults,
      ...(storedConfig.formDefaults || {}),
    },
  };
};
```

### Key Changes

1. **Always use migrated config**: The hook now always returns a complete configuration with all properties present
2. **Graceful fallback**: Missing sections (like `supplyAnalysis`) are filled with defaults
3. **Backward compatibility**: Existing configuration values are preserved
4. **Forward compatibility**: New configuration sections are automatically added

## Result

- ✅ **Existing users**: Old configurations work seamlessly with new defaults applied
- ✅ **New users**: Get the complete default configuration
- ✅ **Upgrading users**: Can access all new features without data loss
- ✅ **Configuration integrity**: All properties are always defined

## Testing Scenarios

1. **Fresh install**: Works with complete default configuration
2. **Existing user with old config**: Automatically migrated with supply analysis disabled by default
3. **Partial corruption**: Any missing configuration sections are restored from defaults

The migration approach ensures zero breaking changes for existing users while enabling new functionality for all.
