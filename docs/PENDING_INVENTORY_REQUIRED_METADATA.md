# Pending Inventory API: Required Metadata Update

## Change Summary

Updated the pending inventory API to require `productLineId`, `setId`, and `productId` parameters for all PUT operations, removing the cross-shard lookup functionality for performance optimization.

## What Changed

### API Requirements

- **Before**: `productLineId`, `setId`, and `productId` were optional - API would perform cross-shard lookup if missing
- **After**: These parameters are **required** - API returns 400 error if any are missing

### Performance Impact

- Eliminated expensive cross-shard SKU lookups
- Reduced database queries per request
- Faster response times for pending inventory operations

### Code Changes

#### `api.pending-inventory.tsx`

1. Removed `skusDb` import (no longer needed)
2. Added validation to require all metadata parameters
3. Removed cross-shard lookup logic
4. Simplified upsert operation to use provided metadata directly

```typescript
// NEW: Strict validation
if (!productLineId || !setId || !productId) {
  return data(
    { error: "productLineId, setId, and productId are required" },
    { status: 400 }
  );
}
```

## Consumer Impact Analysis

### ✅ No Breaking Changes Required

All existing consumers already provide the required metadata:

1. **`useInventoryProcessor.ts`**:

   - Already passes metadata in PUT requests
   - Signature: `(sku, quantity, metadata: { productLineId, setId, productId })`

2. **`pendingInventoryDataSource.ts`**:
   - Only makes GET and DELETE requests
   - No PUT operations affected

### API Contract

```typescript
// PUT Request Body (all fields required)
{
  method: "PUT",
  sku: number,
  quantity: number,
  productLineId: number,  // REQUIRED
  setId: number,          // REQUIRED
  productId: number       // REQUIRED
}
```

## Benefits

- **Performance**: No cross-shard lookups reduce response time
- **Consistency**: Aligns with sharded datastore architecture
- **Reliability**: Eliminates dependency on SKU metadata availability
- **Clarity**: Explicit parameter requirements prevent confusion

## Migration Notes

- **No client updates required** - existing consumers already compliant
- API now fails fast with clear error messages for missing metadata
- Consistent with other sharded API endpoints in the application

## Testing Verification

- ✅ TypeScript compilation passes
- ✅ Development server starts successfully
- ✅ Existing consumers provide required metadata
- ✅ Unique constraint prevents duplicate SKUs
