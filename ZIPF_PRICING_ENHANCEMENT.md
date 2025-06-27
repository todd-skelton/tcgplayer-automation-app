# Enhanced Price Suggestion Algorithm with Zipf Modeling

## Overview

The `getSuggestedPriceFromLatestSales` function has been enhanced to handle cases where a specific condition has insufficient sales data (< 5 sales). When this occurs, the algorithm now employs cross-condition analysis using a Zipf model to provide more robust price suggestions.

## Key Features

### 1. Automatic Cross-Condition Analysis

- **Trigger**: Activates when target condition has fewer than 5 sales
- **Process**: Fetches sales data from all conditions for the same product
- **Benefit**: Provides pricing suggestions even for rare condition/variant combinations

### 2. Zipf Model Implementation

- **Purpose**: Models the relationship between card conditions and their relative prices
- **Method**: Uses ml-levenberg-marquardt for curve fitting on individual sales data
- **Formula**: `price = a / (rank^b)` where rank represents condition quality order
- **Data Source**: Uses every individual sale price rather than averaging by condition
- **Accuracy**: Higher precision by incorporating price variance within each condition

### 3. Individual Sales Processing

- **Granular Analysis**: Each sale is treated as a separate data point in the model
- **Better Variance Capture**: Accounts for price distribution within each condition
- **Robust Fitting**: Requires minimum 3 individual sales for model fitting
- **Fallback Strategy**: Uses condition averages if insufficient individual data points

### 4. Price Normalization

- **Process**: Converts all sales to the target condition using calculated multipliers
- **Accuracy**: Based on fitted Zipf distribution rather than simple averages
- **Robustness**: Handles missing condition data gracefully

## Condition Hierarchy

The algorithm uses the following condition order (best to worst):

1. Near Mint
2. Lightly Played
3. Moderately Played
4. Heavily Played
5. Damaged

## Enhanced Return Data

The function now returns additional information:

```typescript
{
  suggestedPrice?: number;
  totalQuantity: number;
  saleCount: number;
  expectedTimeToSellDays?: number;
  percentiles: PercentileData[];
  usedCrossConditionAnalysis?: boolean;  // NEW
  conditionMultipliers?: Map<Condition, number>;  // NEW
}
```

## Algorithm Flow

```
1. Fetch sales for target condition
2. Check if sales count < 5
   ├─ YES: Proceed with cross-condition analysis
   │   ├─ Fetch sales from all conditions (up to 100 sales)
   │   ├─ Extract individual sale prices by condition rank
   │   ├─ Fit Zipf model using all individual data points
   │   ├─ Generate condition multipliers from fitted curve
   │   ├─ Normalize all sales to target condition
   │   └─ Calculate price suggestion from normalized data
   └─ NO: Use standard single-condition analysis
```

## Benefits

1. **Better Coverage**: Provides pricing for rarely traded condition/variant combinations
2. **Granular Analysis**: Uses individual sales rather than averages for better precision
3. **Data-Driven**: Uses mathematical modeling rather than simple assumptions
4. **Transparent**: Returns the multipliers used for analysis
5. **Backwards Compatible**: Original functionality preserved when sufficient data exists

## Example Usage

```typescript
const result = await getSuggestedPriceFromLatestSales(sku, {
  percentile: 80,
  halfLifeDays: 7,
});

if (result.usedCrossConditionAnalysis) {
  console.log("Used cross-condition analysis");
  console.log("Condition multipliers:", result.conditionMultipliers);
}
```

## Dependencies

- `ml-levenberg-marquardt`: For non-linear curve fitting
- All existing dependencies maintained

## Performance Considerations

- Cross-condition analysis adds one additional API call when triggered
- Fetches up to 100 sales (vs 50 for single condition) for better model accuracy
- Computational overhead is minimal due to efficient curve fitting implementation
