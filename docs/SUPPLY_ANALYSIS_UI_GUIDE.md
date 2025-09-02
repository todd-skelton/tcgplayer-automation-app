# Supply Analysis Configuration UI

The configuration settings page now includes a dedicated section for configuring the supply-adjusted time-to-sell feature.

## Location

Navigate to the **Configuration** page in the application to find the new "Supply Analysis Configuration" section.

## Configuration Options

### Enable Supply Analysis

- **Toggle Switch**: Enables/disables the entire supply analysis feature
- **Default**: Disabled (due to network overhead)
- **Impact**: When enabled, each SKU will make an additional API call to fetch current market listings

### Confidence Weight (0.0 - 1.0)

- **Purpose**: Controls how much to weight supply data vs historical data
- **Default**: 0.7 (70% supply-adjusted, 30% historical)
- **Range**:
  - `0.0` = Pure historical method (same as disabled)
  - `1.0` = Pure supply-based method
  - `0.7` = Recommended balanced approach

### Max Listings Per SKU (50 - 500)

- **Purpose**: Limits the number of listings fetched per SKU for performance
- **Default**: 200
- **Considerations**:
  - Higher values = More accurate analysis but slower processing
  - Lower values = Faster processing but potentially less accurate
  - Listings are fetched in price order (lowest first)

### Include Unverified Sellers

- **Toggle Switch**: Includes/excludes unverified seller listings in analysis
- **Default**: Disabled (verified sellers only)
- **Trade-off**:
  - Enabled = More comprehensive market data
  - Disabled = Higher quality, more reliable pricing data (recommended)

## Visual Indicators

### Information Alert

When supply analysis is enabled, an informational alert appears explaining that:

- Processing time will increase
- Network usage will increase
- Time-to-sell estimates will be more accurate due to current market supply analysis

### Helper Text

Each configuration option includes detailed helper text explaining:

- What the setting controls
- Recommended values
- Performance implications

## Configuration Persistence

All supply analysis settings are automatically saved to browser local storage and will persist across sessions.

## Usage in Different Processors

Once configured, the supply analysis settings will be used by:

1. **Individual Pricing API Calls**: Single SKU lookups via `/api/suggested-price`
2. **Batch Processing**: Inventory processors, pricer tools, etc.
3. **Pipeline Processing**: All pipeline-based pricing operations

## Performance Impact

Enable supply analysis when:

- ✅ Processing smaller batches (< 100 SKUs)
- ✅ Accuracy is more important than speed
- ✅ Network bandwidth is not a concern
- ✅ You want the most current market insights

Consider disabling when:

- ❌ Processing large batches (> 500 SKUs)
- ❌ Speed is critical
- ❌ Network bandwidth is limited
- ❌ API rate limits are a concern

## Default Settings Rationale

| Setting                    | Default Value | Reasoning                                                                 |
| -------------------------- | ------------- | ------------------------------------------------------------------------- |
| Enable Supply Analysis     | `false`       | Conservative default due to network overhead                              |
| Confidence Weight          | `0.7`         | Balanced blend favoring supply data while considering historical patterns |
| Max Listings Per SKU       | `200`         | Good coverage without excessive API usage                                 |
| Include Unverified Sellers | `false`       | Quality over quantity approach                                            |

## Integration with Existing Workflows

The supply analysis configuration seamlessly integrates with existing workflows:

- **Backward Compatible**: Existing configurations continue to work unchanged
- **Opt-In**: Supply analysis is disabled by default
- **Granular Control**: Fine-tune settings based on your specific needs
- **Real-Time Updates**: Changes take effect immediately for new pricing operations

## Monitoring Usage

To monitor supply analysis usage:

1. Check browser console for supply analysis messages
2. Monitor processing times for noticeable increases
3. Watch for any API rate limit warnings
4. Compare time-to-sell estimates before/after enabling

The feature provides a significant enhancement to pricing accuracy by incorporating real-time market supply data while maintaining full backward compatibility.
