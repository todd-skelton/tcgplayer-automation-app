# Inventory SKU API Restructure - Single Request with Product Line Grouping

## Overview

This document outlines the major restructure of the `/api/inventory/skus` endpoint to use a single POST request with product line grouping, eliminating the need for multiple API calls and further optimizing shard-targeted queries.

## Previous Approach Issues

The previous implementation had two suboptimal patterns:

### Pattern 1: Multiple API Calls

```typescript
// Multiple separate API calls for each product line
for (const [productLineId, group] of skusNotFoundByProductLine) {
  const response = await fetch("/api/inventory/skus", {
    method: "POST",
    body: JSON.stringify({
      skuIds: group.skus,
      productLineIds: [productLineId],
    }),
  });
}
```

### Pattern 2: Mixed Cross-Shard Queries

```typescript
// DataEnrichmentService making GET requests with hints
const url = `/api/inventory-skus?skuIds=${skuIds.join(
  ","
)}&productLineIds=${hints.join(",")}`;
// Could still trigger cross-shard queries if SKUs span multiple product lines
```

## New Solution

### Single POST Request Structure

The API now accepts a single request with product line grouping:

```typescript
const response = await fetch("/api/inventory/skus", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    productLineSkus: {
      "1": [123, 456, 789], // Magic: The Gathering SKUs
      "2": [101, 112, 131], // Pokémon SKUs
      "3": [456, 789, 999], // Yu-Gi-Oh! SKUs
    },
  }),
});
```

## Changes Made

### 1. API Endpoint Restructure

**File**: `app/features/inventory-management/routes/api.inventory-skus.tsx`

**Removed GET Support**:

```typescript
export async function loader() {
  return data(
    {
      error:
        "This endpoint only supports POST requests. Use POST with { productLineSkus: { [productLineId]: skuIds[] } } in request body.",
    },
    { status: 405 }
  );
}
```

**Updated POST Handler**:

```typescript
export async function action({ request }: { request: Request }) {
  const { productLineSkus } = await request.json();

  // Validate structure: { [productLineId]: skuIds[] }
  if (!productLineSkus || typeof productLineSkus !== "object") {
    return data(
      { error: "productLineSkus object is required" },
      { status: 400 }
    );
  }

  // Process each product line group with shard-targeted queries
  for (const productLineId of productLineIds) {
    const skus = await skusDb.find<Sku>({
      sku: { $in: validSkuIds },
      productLineId: productLineId, // Direct shard targeting
    });
  }
}
```

### 2. Inventory Processor Optimization

**File**: `app/features/inventory-management/hooks/useInventoryProcessor.ts`

**Before**: Multiple API calls

```typescript
for (const [productLineId, group] of skusNotFoundByProductLine) {
  const skuResponse = await fetch("/api/inventory/skus", {
    method: "POST",
    body: JSON.stringify({
      skuIds: group.skus,
      productLineIds: [productLineId],
    }),
  });
}
```

**After**: Single API call

```typescript
// Create grouped structure
const productLineSkus: { [key: string]: number[] } = {};
for (const [productLineId, group] of skusNotFoundByProductLine) {
  productLineSkus[productLineId.toString()] = group.skus;
}

// Single API call with all groups
const response = await fetch("/api/inventory/skus", {
  method: "POST",
  body: JSON.stringify({ productLineSkus }),
});
```

### 3. Data Enrichment Service Update

**File**: `app/shared/services/dataEnrichmentService.ts`

**Enhanced Product Line Mapping**:

```typescript
async fetchProductDetails(
  skuIds: number[],
  onProgress?: (current: number, total: number, status: string) => void,
  productLineIdHints?: number[],
  originalPricerSkus?: PricerSku[]  // New parameter for mapping
): Promise<Map<number, ProductDisplayInfo>>
```

**Smart SKU Grouping Logic**:

```typescript
// Map SKUs to product lines using originalPricerSkus
if (originalPricerSkus && originalPricerSkus.length > 0) {
  const skuToProductLineMap = new Map<number, number>();
  originalPricerSkus.forEach((pricerSku) => {
    if (pricerSku.productLineId) {
      skuToProductLineMap.set(pricerSku.sku, pricerSku.productLineId);
    }
  });

  // Group uncached SKUs by their product lines
  uncachedSkuIds.forEach((skuId) => {
    const productLineId = skuToProductLineMap.get(skuId);
    if (productLineId) {
      const key = productLineId.toString();
      if (!productLineSkus[key]) {
        productLineSkus[key] = [];
      }
      productLineSkus[key].push(skuId);
    }
  });
}
```

## Performance Benefits

### 1. Reduced Network Overhead

- **Before**: N API calls for N product lines
- **After**: 1 API call regardless of product line count
- **Result**: Faster processing, reduced connection overhead

### 2. Optimal Shard Targeting

- **Before**: Each API call targeted one shard, but required multiple round trips
- **After**: Single API call processes all product lines with optimal shard targeting per group
- **Result**: Best of both worlds - single request with shard efficiency

### 3. Better Error Handling

- **Before**: Partial failures could leave some product lines unprocessed
- **After**: Single transaction handles all product lines, with granular error reporting
- **Result**: More reliable processing with clear error messages

## API Request/Response Examples

### Request Structure

```typescript
POST /api/inventory/skus
{
  "productLineSkus": {
    "1": [123456, 789012, 345678],  // MTG SKUs
    "2": [111222, 333444, 555666],  // Pokemon SKUs
    "3": [777888, 999000, 111333]   // Yu-Gi-Oh SKUs
  }
}
```

### Response Structure

```typescript
// Returns array of SKUs directly (not wrapped in object)
[
  {
    sku: 123456,
    productLineId: 1,
    productName: "Lightning Bolt (#1)",
    condition: "Near Mint",
    variant: "Normal",
    // ... other SKU properties
  },
  // ... more SKUs from all requested product lines
];
```

## Error Handling

### Invalid Request Structure

```json
{
  "error": "productLineSkus object is required with format: { [productLineId]: skuIds[] }",
  "status": 400
}
```

### No Valid Product Lines

```json
{
  "error": "No valid product line IDs provided",
  "status": 400
}
```

### Data Enrichment Mapping Issues

```typescript
// Console warning when SKUs can't be mapped to product lines
console.warn(
  `Could not map all SKUs to product lines. Mapped: ${mapped}, Total: ${total}`
);
```

## Migration Impact

### Breaking Changes

1. **GET requests no longer supported** - All consumers must use POST
2. **New request structure required** - `productLineSkus` object instead of `skuIds` array
3. **Response format unchanged** - Still returns array of enhanced SKUs

### Updated Consumers

- ✅ **Inventory Processor**: Updated to single API call with grouping
- ✅ **Data Enrichment Service**: Updated with smart product line mapping
- ⚠️ **Other consumers**: Will receive 405 error and clear migration instructions

## Future Optimizations

### 1. Parallel Shard Processing

```typescript
// Potential future enhancement: process product line groups in parallel
const promises = productLineIds.map(async (productLineId) => {
  return await skusDb.find({ sku: { $in: skuIds }, productLineId });
});
const results = await Promise.all(promises);
```

### 2. Batch Size Limits

```typescript
// Consider implementing batch size limits for very large requests
const MAX_SKUS_PER_PRODUCT_LINE = 1000;
const MAX_PRODUCT_LINES_PER_REQUEST = 10;
```

### 3. Caching Strategy

```typescript
// Product line specific caching
const cacheKey = `skus:${productLineId}:${skuIds.sort().join(",")}`;
```

## Testing Scenarios

### Single Product Line

```javascript
// Test with one product line
{
  "productLineSkus": {
    "1": [123, 456, 789]
  }
}
```

### Multiple Product Lines

```javascript
// Test with multiple product lines
{
  "productLineSkus": {
    "1": [123, 456],
    "2": [789, 101],
    "3": [112, 131]
  }
}
```

### Error Conditions

```javascript
// Test invalid structure
{ "skuIds": [123, 456] }  // Should return 400 error

// Test empty product lines
{ "productLineSkus": {} }  // Should return 400 error

// Test invalid SKU IDs
{ "productLineSkus": { "1": ["invalid", "skus"] } }  // Should filter out invalid IDs
```

## Related Documentation

This optimization builds upon:

- **Sharded datastore architecture** (see `SHARDED_DATASTORE.md`)
- **Product line grouping optimization** (see `INVENTORY_SKU_GROUPING_OPTIMIZATION.md`)
- **API performance improvements** (see `PHASE_3_API_OPTIMIZATION.md`)

The restructure represents the final evolution of the inventory SKU API, providing optimal performance through single-request processing with perfect shard targeting.
