# Pending Inventory API Optimization

## Overview

This document outlines the optimization made to the pending inventory PUT request to eliminate unnecessary database lookups by passing metadata directly from the UI.

## Problem

Previously, the pending inventory PUT request only sent the `sku` and `quantity` fields:

```javascript
// Old API call
body: JSON.stringify({ method: "PUT", sku, quantity });
```

This forced the API to perform a database lookup to retrieve the required metadata (`productLineId`, `setId`, `productId`) for every pending inventory update, even though this information was already available in the UI.

## Solution

The system has been updated to pass metadata directly from the UI to avoid unnecessary database lookups.

## Changes Made

### 1. Updated Hook Interface

**File**: `app/features/inventory-management/hooks/useInventoryProcessor.ts`

```typescript
// Before
updatePendingInventory: (skuId: number, quantity: number) => void;

// After
updatePendingInventory: (sku: number, quantity: number, metadata: { productLineId: number; setId: number; productId: number }) => void;
```

### 2. Updated API Call

**File**: `app/features/inventory-management/hooks/useInventoryProcessor.ts`

The `updatePendingInventory` function now sends metadata along with the request:

```typescript
const response = await fetch("/api/pending-inventory", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    method: "PUT",
    sku,
    quantity,
    productLineId: metadata.productLineId,
    setId: metadata.setId,
    productId: metadata.productId,
  }),
});
```

### 3. Updated API Handler

**File**: `app/features/pending-inventory/routes/api.pending-inventory.tsx`

The API now accepts metadata in the request and only performs database lookup if metadata is missing:

```typescript
const { method, sku, quantity, productLineId, setId, productId } = formData;

// Use provided metadata if available, otherwise lookup from database
let finalProductLineId = productLineId;
let finalSetId = setId;
let finalProductId = productId;

if (!finalProductLineId || !finalSetId || !finalProductId) {
  // Fallback to database lookup only when necessary
  // ... existing lookup logic
}
```

### 4. Updated Component Interface

**File**: `app/features/inventory-management/components/InventoryEntryTable.tsx`

```typescript
// Updated props interface
interface InventoryEntryTableProps {
  // ... other props
  onUpdateQuantity: (
    sku: number,
    quantity: number,
    metadata: { productLineId: number; setId: number; productId: number }
  ) => void;
}
```

Added helper function to extract metadata from SKU data:

```typescript
const getSkuMetadata = useCallback(
  (sku: number) => {
    const skuData = skus.find((s) => s.sku === sku);
    if (!skuData) {
      throw new Error(`SKU ${sku} not found in available skus`);
    }
    return {
      productLineId: skuData.productLineId,
      setId: skuData.setId,
      productId: skuData.productId,
    };
  },
  [skus]
);
```

All quantity change handlers now pass metadata:

```typescript
const metadata = getSkuMetadata(selectedSku);
onUpdateQuantity(selectedSku, newQty, metadata);
```

## Benefits

### 1. Performance Improvement

- **Eliminates database lookups** for UI-initiated pending inventory updates
- **Reduces API response time** by avoiding cross-shard queries
- **Improves user experience** with faster quantity updates

### 2. Reduced Database Load

- **Fewer database queries** during inventory entry workflow
- **Less strain on ShardedDatastoreManager** during peak usage
- **Better resource utilization** in high-traffic scenarios

### 3. Maintained Backwards Compatibility

- **API still supports metadata lookup** if fields are not provided
- **Graceful fallback** for any legacy callers
- **No breaking changes** for existing functionality

## Data Flow

```
1. User interacts with InventoryEntryTable
   ↓
2. Component extracts metadata from loaded SKU data
   ↓
3. onUpdateQuantity called with (sku, quantity, metadata)
   ↓
4. useInventoryProcessor sends complete data to API
   ↓
5. API uses provided metadata directly (no database lookup)
   ↓
6. Pending inventory updated efficiently
```

## Error Handling

- **UI-level validation**: Component ensures SKU exists in loaded data before calling API
- **API-level fallback**: If metadata is missing, API performs database lookup as before
- **User feedback**: Console errors logged if SKU metadata cannot be found
- **Graceful degradation**: System continues to work even if metadata extraction fails

## Future Considerations

1. **Batch Updates**: Consider implementing batch updates for multiple quantity changes
2. **Optimistic Updates**: Update UI immediately and sync with server in background
3. **Metadata Caching**: Cache frequently accessed metadata to further reduce lookups
4. **Real-time Sync**: Consider WebSocket updates for multi-user scenarios

## Testing

- **Type Safety**: All TypeScript interfaces updated and validated
- **Backwards Compatibility**: API accepts both old and new request formats
- **Error Scenarios**: Proper error handling for missing metadata
- **Integration**: Full data flow from UI to database tested

## Related Changes

This optimization is part of the broader performance improvements including:

- Sharded datastore implementation (see `SHARDED_DATASTORE.md`)
- Required metadata for all pricer logic (see `PRICER_METADATA_REQUIREMENTS.md`)
- Pending inventory optimization (see `PENDING_INVENTORY_OPTIMIZATION.md`)
