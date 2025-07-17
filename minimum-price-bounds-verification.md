# Minimum Price Bounds Verification

## Problem

The pricing system was not applying minimum price bounds using `MIN_PRICE_MULTIPLIER` and `MIN_PRICE_CONSTANT` from the pricing constants. This meant that suggested prices could go below reasonable minimums relative to the market price.

## Solution

Added minimum price bounds checking to both the API endpoint and the pricing pipeline:

### 1. API Endpoint (`api.suggested-price.tsx`)

- Now fetches price points for the SKU to get market price data
- Applies `calculateMarketplacePrice` function to enforce minimum bounds
- Returns bounded price and includes error message if minimum was applied

### 2. Pricing Pipeline (`purePricingService.ts`) - **KEY FIX**

- Modified `createPricedItem` method to apply minimum price bounds
- **CRITICAL**: Fixed data flow to properly separate original suggested price from bounded marketplace price:
  - `pricedItem.suggestedPrice` = original algorithm price (appears in "Suggested Price" CSV column)
  - `pricedItem.price` = bounded minimum price (appears in "TCG Marketplace Price" CSV column)
- Fetches price points for each SKU during processing
- Uses the same `calculateMarketplacePrice` logic for consistency

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
2998629,30.94,28.50,"Suggested price below minimum. Using minimum price."
```

Where:

- **Suggested Price (28.50)** = Original price from pricing algorithm
- **TCG Marketplace Price (30.94)** = Bounded minimum price that will actually be used

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

- `app/routes/api.suggested-price.tsx` - Added bounds checking to API endpoint
- `app/services/purePricingService.ts` - Added bounds checking to pricing pipeline
