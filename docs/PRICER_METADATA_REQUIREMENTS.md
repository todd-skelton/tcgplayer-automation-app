# Pricer Logic Metadata Requirements

## Overview

All pricing operations now require mandatory metadata fields for proper sharding and performance optimization. This document outlines the changes made to enforce these requirements across the entire pricing pipeline.

## Required Fields

All `PricerSku` objects must now include:

- `productLineId` (number): The product line identifier for sharding
- `setId` (number): The set identifier
- `productId` (number): The product identifier

## Data Source Updates

### CSV Data Source

- **File**: `app/features/inventory-management/services/csvDataSource.ts`
- **Converter**: `CsvToPricerSkuConverter` (now async)
- **Behavior**:
  - Uses `productLineName` from CSV to look up `productLineId`
  - Uses `sku + productLineId` to fetch `setId` and `productId` from inventory
  - Throws error if metadata cannot be found

### Seller Inventory Data Source

- **File**: `app/features/seller-management/services/sellerInventoryDataSource.ts`
- **Converter**: `SellerInventoryToPricerSkuConverter` (now async)
- **Behavior**:
  - Looks up `productLineId`, `setId`, `productId` for each SKU from database
  - Uses batch queries for performance
  - Throws error if metadata cannot be found

### Pending Inventory Data Source

- **File**: `app/features/pending-inventory/services/pendingInventoryDataSource.ts`
- **Converter**: `PendingInventoryToPricerSkuConverter` (remains sync)
- **Behavior**:
  - Uses metadata fields directly from `PendingInventoryEntry`
  - No lookup required as fields are now mandatory in pending inventory

## Type System Changes

### PricerSku Type

- **File**: `app/core/types/pricing.ts`
- **Change**: Made `productLineId`, `setId`, `productId` required (removed `?`)
- **Impact**: All pricing operations now enforce these fields at compile time

### PendingInventoryEntry Type

- **File**: `app/features/pending-inventory/types/pendingInventory.ts`
- **Change**: Made `productLineId`, `setId`, `productId` required
- **Impact**: All pending inventory operations must provide these fields

## API Validation

### Pending Inventory API

- **File**: `app/features/pending-inventory/routes/api.pending-inventory.tsx`
- **Validation**: Checks for presence of `productLineId`, `setId`, `productId` on insert
- **Error Handling**: Returns 400 error if metadata is missing

## Converter Interface

### InputConverter Interface

- **File**: `app/features/file-upload/services/dataConverters.ts`
- **Change**: Interface allows both sync and async `convertToPricerSkus` methods
- **Usage**: CSV and Seller Inventory converters are now async, Pending Inventory remains sync

## Migration Strategy

### Data Cleanup

- Pending inventory data was cleared before enforcing required fields
- New data must include all metadata fields

### Error Handling

- CSV uploads that cannot resolve metadata will fail with descriptive errors
- Seller inventory processing will fail if SKUs lack metadata
- UI shows clear error messages for missing product line mapping

## Performance Considerations

### Batch Processing

- Metadata lookups use batch queries to minimize database round trips
- Converters cache product line mappings to avoid repeated lookups
- Sharded queries are now enforced, preventing expensive cross-shard operations

### Async Processing

- CSV and seller inventory processing moved to async patterns
- Progress callbacks maintained for UI feedback
- Background processing preserved for large datasets

## Testing Considerations

### Mock Data

- All test PricerSku objects must include metadata fields
- `architectureDemonstration.ts` updated with example metadata
- Demo functions include realistic `productLineId`, `setId`, `productId` values

### Integration Tests

- CSV upload tests should verify metadata lookup and validation
- Seller inventory tests should verify batch metadata resolution
- Pending inventory tests should verify required field validation

## Breaking Changes

1. **PricerSku objects** without metadata will cause TypeScript compilation errors
2. **CSV files** without valid product line names will fail processing
3. **Pending inventory entries** without metadata will be rejected by API
4. **Manual PricerSku construction** requires all metadata fields

## Migration Checklist

- [x] Update PricerSku type to require metadata fields
- [x] Update PendingInventoryEntry type to require metadata fields
- [x] Make CSV converter async with metadata lookup
- [x] Make seller inventory converter async with metadata lookup
- [x] Update all data sources to handle async converters
- [x] Add API validation for required fields
- [x] Update test/demo code with metadata fields
- [x] Clear existing pending inventory data
- [x] Document changes and requirements

## Future Considerations

- Consider adding metadata validation at the UI level for immediate feedback
- Implement caching strategies for frequently accessed metadata
- Monitor performance impact of additional metadata lookups
- Consider pre-populating metadata during initial data import processes
