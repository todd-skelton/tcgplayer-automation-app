# Supply-Adjusted Time to Sell Feature

This feature enhances the time-to-sell calculations by incorporating current market supply data alongside historical sales data.

## Overview

The traditional time-to-sell calculation is based purely on historical sales intervals. The supply-adjusted approach considers:

1. **Historical Sales Velocity**: How quickly items at or above a target price have sold in the past
2. **Current Market Supply**: How many items are currently listed at or below the target price
3. **Queue Position**: Where your listing would sit in the competitive landscape

## Configuration

### Pipeline Level Configuration

Enable supply analysis in the `PipelineConfig`:

```typescript
const pipelineConfig: PipelineConfig = {
  // ... other config options
  enableSupplyAnalysis: true, // Enable supply-adjusted time to sell
  supplyAnalysisConfig: {
    confidenceWeight: 0.7, // How much to weight supply vs historical (0-1, default 0.7)
    maxListingsPerSku: 200, // Performance limit (default 200)
    includeUnverifiedSellers: false, // Include unverified sellers (default false)
  },
};
```

### PricingConfig Level Configuration

Supply analysis can also be configured at the base pricing level:

```typescript
const pricingConfig: PricingConfig = {
  percentile: 80,
  enableSupplyAnalysis: true,
  supplyAnalysisConfig: {
    confidenceWeight: 0.8, // Higher confidence in supply data
    maxListingsPerSku: 150, // Limit for performance
    includeUnverifiedSellers: true, // Include all sellers
  },
};
```

### Individual Algorithm Configuration

For direct usage of the algorithm:

```typescript
import { getSuggestedPriceFromLatestSales } from "../algorithms/getSuggestedPriceFromLatestSales";

const result = await getSuggestedPriceFromLatestSales(sku, {
  percentile: 80,
  enableSupplyAnalysis: true,
  supplyAnalysisConfig: {
    confidenceWeight: 0.7,
    maxListingsPerSku: 200,
    includeUnverifiedSellers: false,
  },
});
```

## Configuration Parameters

### `enableSupplyAnalysis` (boolean, default: false)

- When `true`, enables supply-adjusted time to sell calculations
- When `false`, uses traditional historical-only calculations
- **Important**: Enabling this significantly increases network calls (1 listings API call per SKU)

### `supplyAnalysisConfig.confidenceWeight` (number, 0-1, default: 0.7)

- Controls the blend between historical and supply-adjusted estimates
- `0.0` = Pure historical method (same as disabled)
- `1.0` = Pure supply-adjusted method
- `0.7` = 70% supply-adjusted, 30% historical (recommended)

### `supplyAnalysisConfig.maxListingsPerSku` (number, default: 200)

- Limits the number of listings fetched per SKU for performance
- Higher values = more accurate but slower
- Lower values = faster but potentially less accurate
- Listings are fetched in price order (lowest first)
- **Optimization**: Listing fetching terminates early when prices exceed the maximum historical sales price

### `supplyAnalysisConfig.maxSalesPrice` (number, optional)

- **Automatically calculated**: Maximum price from historical sales data
- **Purpose**: Enables early termination of listing fetches when prices exceed this maximum
- **Benefits**: Reduces API calls by stopping pagination when irrelevant high-priced listings are encountered
- **Note**: This is set automatically by the algorithm and typically doesn't need manual configuration

### `supplyAnalysisConfig.includeUnverifiedSellers` (boolean, default: false)

- When `false`, only analyzes verified seller listings
- When `true`, includes all seller listings in the analysis
- Verified sellers typically provide more reliable pricing data

## How It Works

1. **Sales Velocity Calculation**:

   ```
   velocity = total_quantity_sold_at_target_price / time_span_days
   ```

2. **Supply Queue Analysis**:

   ```
   queue_position = count_of_items_listed_below_target_price + 1
   ```

3. **Supply-Adjusted Time**:

   ```
   supply_adjusted_days = queue_position / sales_velocity
   ```

4. **Blended Result**:
   ```
   final_time = (historical_time * (1 - confidence)) + (supply_adjusted_time * confidence)
   ```

## Performance Considerations

- **Network Impact**: Each SKU requires an additional API call to fetch listings
- **Processing Time**: Listings analysis adds computational overhead
- **Rate Limits**: Be mindful of TCGPlayer API rate limits when processing many SKUs
- **Memory Usage**: Listings data is cached during processing

### Automatic Performance Optimizations

The system includes several built-in optimizations:

1. **Early Termination**: Listing fetches terminate early when encountering prices above the maximum historical sales price
2. **Client-side Filtering**: Irrelevant high-priced listings are filtered out after each API response
3. **Relevance-Based Fetching**: Only listings relevant to time-to-sell calculations are processed
4. **Paginated Fetching**: Large listing sets are fetched in pages to manage memory usage

These optimizations can significantly reduce the number of irrelevant listings processed and API calls made, improving both speed and reducing network usage.

## Example Usage Scenarios

### High-Volume Processing (Conservative Settings)

```typescript
{
  enableSupplyAnalysis: true,
  supplyAnalysisConfig: {
    confidenceWeight: 0.5, // Conservative blend
    maxListingsPerSku: 100, // Limit for speed
    includeUnverifiedSellers: false, // Verified only
  }
}
```

### Detailed Analysis (Aggressive Settings)

```typescript
{
  enableSupplyAnalysis: true,
  supplyAnalysisConfig: {
    confidenceWeight: 0.8, // Trust supply data highly
    maxListingsPerSku: 300, // Get comprehensive data
    includeUnverifiedSellers: true, // Include all sellers
  }
}
```

### Balanced Approach (Recommended)

```typescript
{
  enableSupplyAnalysis: true,
  supplyAnalysisConfig: {
    confidenceWeight: 0.7, // Balanced blend
    maxListingsPerSku: 200, // Good coverage
    includeUnverifiedSellers: false, // Quality over quantity
  }
}
```

## Fallback Behavior

The system gracefully degrades when supply analysis fails:

- Network errors → Falls back to historical method
- No listings found → Falls back to historical method
- API rate limits → Falls back to historical method
- Invalid data → Falls back to historical method

This ensures the system remains reliable even when supply analysis is unavailable.

## Monitoring and Debugging

Enable console logging to monitor supply analysis performance:

```typescript
// In browser console or server logs, you'll see:
// "Fetching listings for SKU 12345..."
// "Supply analysis unavailable, using historical method"
// "Using supply-adjusted time to sell: 15 days vs historical 8 days"
```

## Migration Guide

To enable supply analysis in existing configurations:

1. **Add the configuration**: Set `enableSupplyAnalysis: true`
2. **Test with small batches**: Start with limited SKU sets
3. **Monitor performance**: Watch for API rate limits and processing time
4. **Adjust parameters**: Tune `confidenceWeight` and `maxListingsPerSku` based on results
5. **Gradual rollout**: Enable for increasingly larger datasets

The feature is backward compatible - existing configurations continue to work unchanged.
