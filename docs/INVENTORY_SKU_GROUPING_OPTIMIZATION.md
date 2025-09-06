# Inventory SKU API Optimization - Product Line Grouping

## Overview

This document outlines the optimization made to the inventory SKU fetching process to group SKU requests by product line ID, eliminating cross-shard queries and improving performance.

## Problem

Previously, when pending inventory contained SKUs from multiple product lines, the system would:

1. Collect all missing SKUs into a single array
2. Make one API call with all SKU IDs
3. Force the API to perform cross-shard queries across multiple product lines
4. Result in slower performance and increased database load

```typescript
// Previous approach - inefficient for multiple product lines
const skusNotFound: number[] = [123, 456, 789]; // SKUs from different product lines
const response = await fetch("/api/inventory/skus", {
  method: "POST",
  body: JSON.stringify({ skuIds: skusNotFound }), // Cross-shard query required
});
```

## Solution

The system now groups SKU requests by product line ID and makes separate API calls for each product line, allowing each call to target a specific shard.

## Changes Made

### 1. Updated Inventory Processor

**File**: `app/features/inventory-management/hooks/useInventoryProcessor.ts`

**Before:**

```typescript
const skusNotFound: number[] = [];
// ... collect all SKUs into single array
const response = await fetch("/api/inventory/skus", {
  method: "POST",
  body: JSON.stringify({ skuIds: skusNotFound }),
});
```

**After:**

```typescript
const skusNotFoundByProductLine: Map<
  number,
  { skus: number[]; entries: PendingInventoryEntry[] }
> = new Map();

// Group SKUs by product line ID
for (const pendingEntry of state.pendingInventory) {
  if (!skuData) {
    const productLineId = pendingEntry.productLineId;
    if (!skusNotFoundByProductLine.has(productLineId)) {
      skusNotFoundByProductLine.set(productLineId, { skus: [], entries: [] });
    }
    const group = skusNotFoundByProductLine.get(productLineId)!;
    group.skus.push(sku);
    group.entries.push(pendingEntry);
  }
}

// Make separate API calls for each product line
for (const [productLineId, group] of skusNotFoundByProductLine) {
  const skuResponse = await fetch("/api/inventory/skus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skuIds: group.skus,
      productLineIds: [productLineId], // Target specific shard
    }),
  });
}
```

### 2. Enhanced Data Structure

The processor now uses a `Map` to efficiently group SKUs by product line:

```typescript
Map<
  productLineId,
  {
    skus: number[]; // SKU IDs for this product line
    entries: PendingInventoryEntry[]; // Corresponding pending entries
  }
>;
```

This structure allows:

- **Efficient grouping** during the collection phase
- **Easy access** to both SKU IDs and related pending entries
- **Preserved metadata** for creating PricerSku objects

## Performance Benefits

### 1. Eliminated Cross-Shard Queries

- **Before**: Single API call could query across multiple shards
- **After**: Each API call targets a specific shard based on product line ID
- **Result**: Faster database queries and reduced resource usage

### 2. Improved Parallelization

- **Multiple product lines**: Each API call can execute independently
- **Database load distribution**: Queries spread across appropriate shards
- **Reduced contention**: Less competition for database resources

### 3. Better Error Handling

- **Isolated failures**: If one product line fails, others can still succeed
- **Granular logging**: Easier to identify which product lines have issues
- **Partial processing**: Can continue with successfully fetched SKUs

## API Behavior

The existing `/api/inventory/skus` endpoint already supports this optimization through the `productLineIds` parameter:

```typescript
// API action method in api.inventory-skus.tsx
if (productLineIdHints && productLineIdHints.length > 0) {
  // Uses shard-targeted queries for better performance
  skus = await skusDb.find<Sku>({
    sku: { $in: skuIds },
    productLineId: { $in: productLineIdHints },
  });
} else {
  // Fallback to cross-shard search
  skus = await skusDb.crossShardFind<Sku>({ sku: { $in: skuIds } });
}
```

By providing `productLineIds: [specificProductLineId]`, each call uses the efficient shard-targeted query path.

## Usage Scenarios

### Scenario 1: Single Product Line

```typescript
// All pending inventory from one product line (e.g., Magic: The Gathering)
// Makes 1 API call targeting 1 shard
skusNotFoundByProductLine = Map {
  1 => { skus: [123, 456, 789], entries: [...] }
}
```

### Scenario 2: Multiple Product Lines

```typescript
// Pending inventory from multiple product lines
// Makes 3 API calls, each targeting its respective shard
skusNotFoundByProductLine = Map {
  1 => { skus: [123, 456], entries: [...] },      // Magic: The Gathering
  2 => { skus: [789, 101], entries: [...] },      // Pokémon
  3 => { skus: [112, 131], entries: [...] }       // Yu-Gi-Oh!
}
```

## Error Handling

The updated implementation includes robust error handling for each product line group:

```typescript
if (skuResponse.ok) {
  const skuDataArray = await skuResponse.json();
  allFetchedSkus.push(...skuDataArray);
} else {
  console.warn(`Failed to fetch SKU data for product line ${productLineId}`);
  // Continue processing other product lines
}
```

This ensures that:

- **Partial failures don't block processing**
- **Clear error messages** identify problematic product lines
- **Successful fetches proceed** even if some product lines fail

## Data Flow

```
Pending Inventory Entries
         ↓
    Group by productLineId
         ↓
  Map<productLineId, {skus, entries}>
         ↓
   For each product line group:
         ↓
   API call with productLineIds hint
         ↓
   Shard-targeted SKU query
         ↓
   Merge all fetched SKUs
         ↓
   Create PricerSku objects
```

## Future Considerations

1. **Batch Size Limits**: Consider implementing batch size limits for very large product line groups
2. **Parallel Execution**: Could execute multiple product line API calls in parallel for even better performance
3. **Caching Strategy**: Consider caching recently fetched SKU data by product line
4. **Monitoring**: Add metrics to track performance improvements from this optimization

## Related Optimizations

This optimization works in conjunction with other performance improvements:

- **Sharded datastore architecture** (see `SHARDED_DATASTORE.md`)
- **Required metadata enforcement** (see `PRICER_METADATA_REQUIREMENTS.md`)
- **Pending inventory API optimization** (see `PENDING_INVENTORY_API_OPTIMIZATION.md`)

## Testing

To verify the optimization:

1. **Create pending inventory** with SKUs from multiple product lines
2. **Process the inventory** and observe the API calls in network tab
3. **Verify** that separate calls are made for each product line
4. **Check database logs** to confirm shard-targeted queries instead of cross-shard queries

The optimization maintains full backwards compatibility while providing significant performance improvements for multi-product-line scenarios.
