# TCGPlayer Automation App - Seller Inventory Pricer

## New Features

### Seller Inventory Pricer

A new component that allows you to price all listings for a specific seller without needing to upload a CSV file.

**How it works:**

1. Enter a seller key (unique identifier for the seller)
2. Select the pricing percentile
3. The system will:
   - Fetch all active listings for that seller using the TCGPlayer search API
   - Convert the search results to the same format as CSV listings
   - Run the pricing algorithm on each item
   - Download a priced CSV file with all the seller's inventory

**Route:** `/seller-pricer`

### Refactored Architecture

The codebase has been refactored to eliminate code duplication between CSV processing and seller inventory processing:

#### Shared Components

1. **`ListingProcessor`** (`app/services/listingProcessor.ts`)

   - Core pricing logic extracted from the original CSV processor
   - Handles pricing calculations, error management, and summary generation
   - Used by both CSV and seller inventory processors

2. **`SellerInventoryService`** (`app/services/sellerInventoryService.ts`)

   - Fetches seller inventory using the TCGPlayer search API
   - Handles pagination and filtering of search results

3. **`InventoryConverter`** (`app/services/inventoryConverter.ts`)
   - Converts search result products to the TCGPlayerListing format
   - Ensures compatibility between API data and existing pricing logic
   - Maps `productConditionId` from listings to `TCGplayer Id` (SKU) for proper pricing
   - Filters out custom listings (those with `customListingId`) that have manually set prices
   - Leaves `TCG Market Price` field empty to be populated with accurate SKU-level market prices

#### Hooks

1. **`useCSVProcessor`** - Simplified to use the shared `ListingProcessor`
2. **`useSellerInventoryProcessor`** - New hook for seller inventory processing

#### Components

1. **`SellerForm`** - New form component for entering seller key and percentile
2. All existing components (`UploadForm`, `ProgressIndicator`, `ProcessingSummary`) are reused

## API Usage

The seller inventory pricer uses a backend API endpoint (`/api/seller-inventory`) to avoid CORS issues. The backend:

1. Receives the seller key from the frontend
2. Makes calls to the TCGPlayer search API (`get-search-results.ts`) with:
   - Filters by `sellerKey` to get only listings from the specified seller
   - Searches across all product lines and sets for that seller
   - Only includes active listings with quantity >= 1
3. Converts the search results to the seller inventory format
4. Returns the processed data to the frontend

This approach ensures that all external API calls are made from the server-side, preventing CORS issues while maintaining the same functionality.

## File Structure

```
app/
├── services/
│   ├── listingProcessor.ts          # Shared pricing logic
│   ├── sellerInventoryService.ts    # Frontend service for seller inventory
│   ├── inventoryConverter.ts        # Data format conversion
│   └── pricingService.ts            # Existing pricing API calls
├── hooks/
│   ├── useCSVProcessor.ts           # Refactored CSV processing
│   └── useSellerInventoryProcessor.ts # New seller inventory processing
├── components/
│   ├── SellerForm.tsx               # New seller input form
│   └── ...                         # Existing components
└── routes/
    ├── pricer.tsx                   # Existing CSV pricer route
    ├── seller-pricer.tsx            # New seller inventory pricer route
    ├── api.suggested-price.tsx      # Existing pricing API
    └── api.seller-inventory.tsx     # New seller inventory API
```

## Benefits of Refactoring

1. **No Code Duplication**: Core pricing logic is shared between both processing methods
2. **Consistent Results**: Both CSV and seller inventory processing use identical algorithms
3. **Maintainability**: Changes to pricing logic only need to be made in one place
4. **Extensibility**: Easy to add new data sources (API endpoints, other file formats) using the shared processor

## Usage

### CSV Pricer (Existing)

- Navigate to `/pricer`
- Upload a TCGPlayer CSV file
- Select pricing percentile
- Download priced results

### Seller Inventory Pricer (New)

- Navigate to `/seller-pricer`
- Enter seller key
- Select pricing percentile
- System automatically fetches inventory and downloads priced results

Both methods produce the same CSV output format with identical pricing calculations.

## CORS Handling

To prevent CORS issues when making calls to external APIs, the seller inventory functionality uses a backend API endpoint pattern:

1. **Frontend** (`SellerInventoryService`) makes a POST request to `/api/seller-inventory` with the seller key
2. **Backend** (`api.seller-inventory.tsx`) receives the request and makes the actual calls to the TCGPlayer search API
3. **Backend** processes the results and returns the seller inventory data to the frontend
4. **Frontend** continues with the pricing logic using the received data

This architecture ensures all external API calls are made server-side, avoiding browser CORS restrictions while maintaining the same user experience.

## Important Technical Details

### SKU Mapping

The `TCGplayer Id` field in the CSV format represents the SKU (Stock Keeping Unit), not the product ID. When converting from search results to TcgPlayerListing format:

- **Product ID**: Identifies the base product (e.g., "Lightning Bolt")
- **SKU (`productConditionId`)**: Identifies the specific variant (e.g., "Lightning Bolt - Near Mint - English")

The converter correctly maps `listing.productConditionId` to the `TCGplayer Id` field to ensure proper pricing algorithm compatibility.

### SKU-Level Market Price Usage

The system uses **SKU-level market prices** (condition-specific) rather than product-level market prices for accurate min/max price enforcement:

1. **Market Price Fetching**: The `ListingProcessor` calls `/api/price-points` to fetch market prices for each SKU (productConditionId)
2. **Condition-Specific Pricing**: Each condition (Near Mint, Lightly Played, etc.) has its own market price
3. **Accurate Bounds**: Min/max price enforcement uses the correct condition-specific market price, not the generic product price
4. **CSV Display**: The `TCG Market Price` field in the output CSV shows the actual SKU-level market price used in calculations

This ensures that pricing logic accounts for condition-specific market dynamics rather than using a single market price for all conditions of a product.

### Custom Listing Exclusion

The system automatically excludes custom listings from processing. Custom listings are identified by having a `customData.customListingId` value and represent items where prices have been manually set by the seller. These are filtered out because:

- They don't follow standard pricing algorithms
- Their prices are manually curated and shouldn't be automatically adjusted
- Including them would skew pricing calculations for similar items
