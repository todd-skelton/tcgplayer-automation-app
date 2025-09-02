# Configuration & Local Storage System

This document explains the new configuration system that stores user preferences and form defaults in local storage instead of using hard-coded constants.

## Overview

The configuration system allows users to customize:

- Pricing parameters (percentiles, multipliers, thresholds)
- File handling settings (accepted types, output prefixes)
- Form default values (percentile, seller keys)

All settings are automatically saved to local storage and persist across browser sessions.

## New Files Created

### `app/hooks/useConfiguration.ts`

Main configuration hook that provides:

- `config` - Current configuration object
- `updatePricingConfig()` - Update pricing-related settings
- `updateFileConfig()` - Update file handling settings
- `updateFormDefaults()` - Update form default values
- `resetToDefaults()` - Reset all settings to original defaults
- `percentiles` - Computed array of percentiles based on config

### `app/routes/configuration.tsx`

Full configuration management page where users can:

- Adjust all pricing parameters
- Modify file handling settings
- Set form defaults
- Reset everything to defaults

### `app/components/QuickSettings.tsx`

Compact settings display component showing:

- Current default percentile
- Percentile range
- Last used seller key (if any)
- Quick link to full configuration page

## Updated Files

### Form Components

- **UploadForm**: Now uses configurable defaults and saves last used percentile
- **SellerForm**: Uses and saves seller key and percentile preferences

### Route Components

- **pending-inventory-pricer**: Uses configurable percentile defaults
- **pricer**: Added QuickSettings display
- **ProcessingSummary**: Uses configurable success rate thresholds

### Navigation

- **home.tsx**: Added Configuration button to main navigation
- **routes.ts**: Added `/configuration` route

## Configuration Structure

```typescript
interface AppConfiguration {
  pricing: {
    defaultPercentile: number; // Default: 65
    percentileStep: number; // Default: 10
    minPercentile: number; // Default: 0
    maxPercentile: number; // Default: 100
    skipPrefix: string; // Default: "C-"
    minPriceMultiplier: number; // Default: 80/85
    minPriceConstant: number; // Default: 0.1
    successRateThreshold: {
      low: number; // Default: 70
      high: number; // Default: 90
    };
  };
  file: {
    accept: string; // Default: ".csv"
    outputPrefix: string; // Default: "priced-listings-"
    mimeType: string; // Default: "text/csv"
  };
  formDefaults: {
    percentile: number; // Updated from form submissions
    sellerKey: string; // Updated from form submissions
  };
}
```

## Usage Examples

### Using Configuration in Components

```typescript
import { useConfiguration } from "../hooks/useConfiguration";

function MyComponent() {
  const { config, updateFormDefaults } = useConfiguration();

  // Use current settings
  const defaultPercentile = config.formDefaults.percentile;

  // Update settings
  updateFormDefaults({ percentile: 80 });
}
```

### Form Auto-Save Behavior

- **Upload Form**: Saves percentile when form is submitted
- **Seller Form**: Saves both seller key and percentile on submission
- **Pending Inventory**: Saves percentile when processing starts

### Configuration Persistence

- All settings stored in `localStorage` under key `"tcgplayer-automation-config"`
- Form defaults stored separately under `"tcgplayer-form-defaults"`
- Settings persist across browser sessions and page reloads
- Falls back to original constants if localStorage is unavailable

## Benefits

1. **User Convenience**: Forms remember last used values
2. **Customization**: Users can adjust pricing parameters to their needs
3. **Backwards Compatibility**: Original constants remain as defaults
4. **Automatic Persistence**: No manual save/load required
5. **Progressive Enhancement**: Works even if localStorage is disabled

## Migration from Constants

The original `PRICING_CONSTANTS` and `FILE_CONFIG` are still available as defaults, but components now use the configurable versions. This ensures:

- No breaking changes to existing functionality
- Gradual adoption of configuration system
- Fallback behavior if configuration fails

## Accessing Configuration Page

Users can access configuration settings via:

- Main navigation "⚙️ Configuration" button on home page
- Settings icon in QuickSettings component (shown on forms)
- Direct URL: `/configuration`
