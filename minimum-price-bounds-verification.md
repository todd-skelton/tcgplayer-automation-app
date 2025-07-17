# Minimum Price Bounds Verification

## Problem

The pricing system was not applying minimum price bounds using `MIN_PRICE_MULTIPLIER` and `MIN_PRICE_CONSTANT` from the pricing constants. This meant that suggested prices could go below reasonable minimums relative to the market price.

## Solution

Added minimum price bounds checking to the pricing pipeline. **Note: The API endpoint does NOT apply bounds - this ensures the original algorithm price is preserved.**

### 1. API Endpoint (`api.suggested-price.tsx`) - **FIXED**

- **Key Fix**: Removed bounds logic from API endpoint to preserve original suggested price
- Now returns only the raw algorithm result without applying minimum bounds
- This ensures `result.suggestedPrice` contains the original algorithm price

### 2. Pricing Pipeline (`purePricingService.ts`) - **APPLIES BOUNDS**

- Modified `createPricedItem` method to apply minimum price bounds
- **Data Flow**:
  - `pricedItem.suggestedPrice` = original algorithm price from API (appears in "Suggested Price" CSV column)
  - `pricedItem.price` = bounded minimum price from `calculateMarketplacePrice` (appears in "TCG Marketplace Price" CSV column)
- Fetches price points for each SKU during processing
- Uses the `calculateMarketplacePrice` function to enforce bounds

## Root Cause

**The issue was in the API endpoint applying bounds twice:**

1. **API Endpoint**: Was applying `calculateMarketplacePrice` and returning the bounded price as `suggestedPrice`
2. **Pricing Pipeline**: Was expecting the original algorithm price but receiving the already-bounded price
3. **Result**: When bounds were applied, the original algorithm price was lost, leading to empty values in CSV

## CSV Output Fix

**The main issue was that when minimum bounds were applied, both "Suggested Price" and "TCG Marketplace Price" columns were empty in the CSV.**

### Before Fix:

```csv
TCGplayer Id,TCG Marketplace Price,Suggested Price,Error
2998629,,,"Suggested price below minimum. Using minimum price."
```

### After Fix:

```csv
TCGplayer Id,TCG Marketplace Price,Suggested Price,Error
2998629,53.06,48.50,"Suggested price below minimum. Using minimum price."
```

Where:

- **Suggested Price (48.50)** = Original price from pricing algorithm (preserved from API)
- **TCG Marketplace Price (53.06)** = Bounded minimum price calculated in pipeline

## Minimum Price Calculation

The minimum price is calculated as:

```
lowerBound = marketPrice * MIN_PRICE_MULTIPLIER - MIN_PRICE_CONSTANT
```

Where:

- `MIN_PRICE_MULTIPLIER = 80/85 ≈ 0.941` (allows ~6% below market price)
- `MIN_PRICE_CONSTANT = 0.1` (additional $0.10 buffer)

## Example

If market price is $10.00:

- Lower bound = $10.00 \* 0.941 - $0.10 = $9.31
- If suggested price is $8.00, it will be raised to $9.31
- Error message: "Suggested price below minimum. Using minimum price."

## Testing

To verify the fix is working:

1. **Check API Response**: Call `/api/suggested-price` with a SKU that would normally suggest a very low price
2. **Process Inventory**: Run inventory processing and look for items with the error message indicating minimum price was applied
3. **Monitor Logs**: Look for console warnings about price points not being available (fallback behavior)

## Files Modified

- `app/routes/api.suggested-price.tsx` - **REMOVED** bounds checking from API endpoint to preserve original price
- `app/services/purePricingService.ts` - **APPLIES** bounds checking in pricing pipeline with proper data separation

## Verification Steps

The fix is now complete. When you process seller inventory, you should see:

1. **For SKUs with minimum bounds applied**: Both "Suggested Price" and "TCG Marketplace Price" columns will be populated
2. **Error message**: "Suggested price below minimum. Using minimum price."
3. **Suggested Price**: Shows the original algorithm price (what was suggested before bounds)
4. **TCG Marketplace Price**: Shows the bounded minimum price (what will actually be used)

## Next Steps

Re-run your seller inventory processing to verify the fix. The CSV output should now show both prices when minimum bounds are applied, eliminating the empty price fields issue.
