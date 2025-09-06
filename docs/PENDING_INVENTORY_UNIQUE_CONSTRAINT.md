# Pending Inventory Unique Constraint Fix

## Problem

The pending inventory API was allowing duplicate SKU entries when called multiple times simultaneously, causing data inconsistency and duplicate records in the database.

## Root Cause

1. The `pendingInventoryDb` had an index on `sku` field but it was not marked as unique
2. The API used a "check then insert" pattern instead of atomic upsert operations
3. Race conditions could occur when multiple requests for the same SKU arrived simultaneously

## Solution

### 1. Database Constraint

Added unique constraint to the SKU field in `datastores.ts`:

```typescript
pendingInventoryDb.ensureIndex({ fieldName: "sku", unique: true });
```

### 2. Atomic Upsert Logic

Modified the pending inventory API in `api.pending-inventory.tsx` to use atomic upsert operations:

- **Before**: Check if existing → Update or Insert (race condition possible)
- **After**: Try Update → If no rows affected, Insert → Handle unique constraint violation gracefully

### 3. Required Metadata

**UPDATED**: The API now requires `productLineId`, `setId`, and `productId` to be provided in all requests:

- Removed cross-shard lookup functionality for performance optimization
- All calls must include the required metadata parameters
- Returns 400 error if any required metadata is missing

### 4. Error Handling

Added proper error handling for unique constraint violations:

- If insert fails due to duplicate key, automatically retry with update operation
- Ensures the operation succeeds even under race conditions

## Implementation Details

The new logic flow:

1. Validate that `productLineId`, `setId`, and `productId` are provided (returns 400 if missing)
2. Try to update existing entry by SKU
3. If update affects 0 rows (no existing entry), insert new entry
4. If insert fails with unique constraint error, retry with update
5. This ensures exactly one entry per SKU regardless of timing

## Benefits

- **Data Integrity**: Prevents duplicate SKU entries
- **Race Condition Safety**: Handles concurrent requests correctly
- **Atomic Operations**: Single transaction prevents inconsistent states
- **Performance Optimization**: No cross-shard lookups required
- **Strict Metadata Requirements**: Ensures all entries have required shard keys

## Migration Notes

- Existing duplicate entries (if any) should be manually cleaned up
- The unique constraint will prevent new duplicates going forward
- **BREAKING CHANGE**: All API calls must now include `productLineId`, `setId`, and `productId`
- Clients that relied on automatic metadata lookup will need to be updated

## Testing Recommendations

1. Test concurrent API calls with same SKU
2. Verify existing entries are updated correctly
3. Confirm new entries are created when SKU doesn't exist
4. Validate error handling for constraint violations
5. **Test that API returns 400 error when required metadata is missing**
