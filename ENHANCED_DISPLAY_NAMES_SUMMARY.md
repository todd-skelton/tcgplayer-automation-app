# Enhanced Display Names for CSV Exports - Implementation Summary

## Overview

Updated the CSV export functionality to use the same enhanced display names that are shown in the inventory table, including card numbers, rarity, and language information.

## Changes Made

### 1. Created Display Name Utility (`app/utils/displayNameUtils.ts`)

- `createDisplayName()`: Creates consistent display names with product name, card number, rarity, and language
- `extractCardNumber()`: Helper function to extract card numbers from various sources
- This ensures consistency between the inventory table and CSV exports

### 2. Updated API Endpoint (`app/routes/api.inventory-skus.tsx`)

- Added `cardNumber` field to the response data
- Added `originalProductName` field to preserve the original product name for enhanced display name creation
- This provides all necessary data for creating comprehensive display names

### 3. Updated Data Enrichment Service (`app/services/dataEnrichmentService.ts`)

- Modified to use the new `createDisplayName` utility function
- Uses `originalProductName` if available, fallback to existing `productName`
- Incorporates card number, rarity, variant, and language information for comprehensive display names

### 4. Updated Inventory Entry Table (`app/components/InventoryEntryTable.tsx`)

- Removed duplicate `createDisplayName` function
- Now imports and uses the shared utility function for consistency

## Benefits

### Before

```
Product: Appletun (#023/192)
```

### After

```
Product: Appletun - 023/192 - Common - Reverse Holofoil
```

### For Non-English Cards

```
Product: Appletun - 023/192 - Common - Japanese
```

## CSV Export Files Affected

All CSV exports now use the enhanced display names:

- Pending Inventory Pricing (`usePendingInventoryPipelineProcessor`)
- Seller Inventory Pricing (`useSellerInventoryPipelineProcessor`)
- CSV File Processing (`useCSVPipelineProcessor`)
- Manual Inventory Processing (`useInventoryProcessor`)

## Technical Notes

- The enhanced display names are created during the data enrichment phase
- No breaking changes to existing interfaces
- Maintains backward compatibility with existing data
- Type-safe implementation with proper error handling

## Testing

- All TypeScript compilation passes
- Build process completes successfully
- Existing functionality preserved while adding enhanced display capabilities
