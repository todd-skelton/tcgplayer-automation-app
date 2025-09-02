import type {
  SkuPricingData,
  PurePricingConfig,
  BatchPricingData,
} from "../types/pricingData";
import { PricingDataGatheringService } from "../services/pricingDataGatheringService";
import { PurePricingService } from "../services/purePricingService";

/**
 * Example demonstrating the new pure pricing pipeline
 * This shows how to test and use the refactored pricing system
 */

// Mock data for testing
const createMockSkuData = (): SkuPricingData => ({
  sku: {
    id: 12345,
    productId: 100,
    productLineId: 1,
    condition: "Near Mint",
    language: "English",
    variant: "Normal",
    quantity: 1,
    addToQuantity: 0,
    currentPrice: 10.0,
  },
  sales: [
    {
      purchasePrice: 10.0,
      quantity: 1,
      orderDate: "2024-01-01T00:00:00Z",
      condition: "Near Mint",
    },
    {
      purchasePrice: 12.0,
      quantity: 1,
      orderDate: "2024-01-02T00:00:00Z",
      condition: "Near Mint",
    },
    {
      purchasePrice: 11.0,
      quantity: 2,
      orderDate: "2024-01-03T00:00:00Z",
      condition: "Lightly Played",
    },
    {
      purchasePrice: 9.0,
      quantity: 1,
      orderDate: "2024-01-04T00:00:00Z",
      condition: "Moderately Played",
    },
  ] as any[],
  categoryFilter: {
    categoryId: 1,
    languages: [{ id: 1, name: "English" }],
    variants: [{ id: 1, name: "Normal" }],
  },
  listings: [
    {
      price: 12.5,
      quantity: 3,
      condition: "Near Mint",
      sellerKey: "seller1",
      isVerified: true,
    },
    {
      price: 11.0,
      quantity: 2,
      condition: "Near Mint",
      sellerKey: "seller2",
      isVerified: true,
    },
  ] as any[],
  pricePoint: {
    skuId: 12345,
    marketPrice: 15.0,
    lowestPrice: 8.0,
    highestPrice: 20.0,
    priceCount: 10,
    calculatedAt: "2024-01-01T00:00:00Z",
  },
  productInfo: {
    productLine: "Magic: The Gathering",
    setName: "Alpha",
    productName: "Black Lotus",
    condition: "Near Mint",
    variant: "Normal",
  },
});

/**
 * Example 1: Testing individual SKU pricing with pure functions
 */
export function testSingleSkuPricing() {
  console.log("=== Testing Single SKU Pricing ===");

  const pricingService = new PurePricingService();
  const skuData = createMockSkuData();

  const config: PurePricingConfig = {
    percentile: 80,
    halfLifeDays: 7,
    enableSupplyAnalysis: true,
    supplyAnalysisConfig: {
      maxListingsPerSku: 200,
      includeUnverifiedSellers: false,
    },
  };

  // This is now a pure function - fully testable!
  const result = pricingService["calculateSingleSkuPrice"](skuData, config);

  console.log("Pricing Result:", {
    sku: result.sku,
    suggestedPrice: result.suggestedPrice,
    finalPrice: result.price,
    historicalVelocityDays: result.historicalSalesVelocityMs
      ? result.historicalSalesVelocityMs / (24 * 60 * 60 * 1000)
      : undefined,
    estimatedTimeToSellDays: result.estimatedTimeToSellMs
      ? result.estimatedTimeToSellMs / (24 * 60 * 60 * 1000)
      : undefined,
    usedCrossConditionAnalysis: result.usedCrossConditionAnalysis,
    errors: result.errors,
    warnings: result.warnings,
    percentileCount: result.percentiles.length,
  });

  return result;
}

/**
 * Example 2: Testing batch pricing with multiple SKUs
 */
export function testBatchPricing() {
  console.log("\n=== Testing Batch Pricing ===");

  const pricingService = new PurePricingService();

  // Create batch data with multiple SKUs
  const batchData: BatchPricingData = {
    skusData: [
      createMockSkuData(),
      {
        ...createMockSkuData(),
        sku: { ...createMockSkuData().sku, id: 12346 },
        sales: [
          {
            purchasePrice: 5.0,
            quantity: 1,
            orderDate: "2024-01-01T00:00:00Z",
            condition: "Near Mint",
          },
          {
            purchasePrice: 6.0,
            quantity: 2,
            orderDate: "2024-01-02T00:00:00Z",
            condition: "Near Mint",
          },
        ] as any[],
      },
      {
        ...createMockSkuData(),
        sku: { ...createMockSkuData().sku, id: 12347 },
        sales: [], // This should fail
      },
    ],
    config: {
      percentile: 75,
      enableSupplyAnalysis: false,
    },
  };

  // Pure batch processing - no external dependencies!
  const result = pricingService.calculateBatchPrices(batchData);

  console.log("Batch Result Stats:", result.stats);
  console.log("Aggregated Percentiles:", result.aggregatedPercentiles);

  result.results.forEach((skuResult, index) => {
    console.log(`SKU ${skuResult.sku}:`, {
      price: skuResult.price,
      errors: skuResult.errors?.length || 0,
      warnings: skuResult.warnings?.length || 0,
    });
  });

  return result;
}

/**
 * Example 3: Demonstrating easy mocking for unit tests
 */
export function demonstrateMocking() {
  console.log("\n=== Demonstrating Easy Mocking ===");

  // Create a mock SKU with specific conditions to test edge cases
  const mockSkuWithLowPrices: SkuPricingData = {
    sku: {
      id: 99999,
      productId: 999,
      productLineId: 99,
      condition: "Near Mint",
      language: "English",
      variant: "Normal",
    },
    sales: [
      {
        purchasePrice: 0.5, // Very low price
        quantity: 1,
        orderDate: "2024-01-01T00:00:00Z",
        condition: "Near Mint",
      },
      {
        purchasePrice: 0.75,
        quantity: 1,
        orderDate: "2024-01-02T00:00:00Z",
        condition: "Near Mint",
      },
    ] as any[],
    categoryFilter: {
      categoryId: 99,
      languages: [{ id: 1, name: "English" }],
      variants: [{ id: 1, name: "Normal" }],
    },
    pricePoint: {
      skuId: 99999,
      marketPrice: 10.0, // Much higher than sales
      lowestPrice: 3.0,
      highestPrice: 15.0,
      priceCount: 5,
      calculatedAt: "2024-01-01T00:00:00Z",
    },
  };

  const pricingService = new PurePricingService();
  const config: PurePricingConfig = {
    percentile: 80,
    enableSupplyAnalysis: false,
  };

  const result = pricingService["calculateSingleSkuPrice"](
    mockSkuWithLowPrices,
    config
  );

  console.log("Edge Case Result:", {
    suggestedPrice: result.suggestedPrice,
    finalPrice: result.price,
    priceWasAdjusted: result.price !== result.suggestedPrice,
    warnings: result.warnings,
  });

  return result;
}

/**
 * Example 4: Performance comparison demonstration
 */
export function demonstratePerformanceComparison() {
  console.log("\n=== Performance Comparison Demo ===");

  // In the old system, each pricing operation would make multiple API calls
  // In the new system, all data is gathered upfront

  const startTime = Date.now();

  // Simulate gathering data for 100 SKUs (this would be done once)
  const skuCount = 100;
  console.log(`Simulating data gathering for ${skuCount} SKUs...`);

  // In the new system, this is where all external calls happen
  const gatheringTime = Date.now();
  console.log(`Data gathering phase: ${gatheringTime - startTime}ms`);

  // Now pricing is pure computation (much faster and predictable)
  const pricingService = new PurePricingService();
  const mockBatchData: BatchPricingData = {
    skusData: Array(skuCount)
      .fill(null)
      .map((_, index) => ({
        ...createMockSkuData(),
        sku: { ...createMockSkuData().sku, id: index + 1 },
      })),
    config: {
      percentile: 80,
      enableSupplyAnalysis: false,
    },
  };

  const pricingStartTime = Date.now();
  const result = pricingService.calculateBatchPrices(mockBatchData);
  const pricingEndTime = Date.now();

  console.log(
    `Pure pricing computation: ${pricingEndTime - pricingStartTime}ms`
  );
  console.log(`Total time: ${pricingEndTime - startTime}ms`);
  console.log(`Successful pricing: ${result.stats.processed}/${skuCount}`);

  return result;
}

/**
 * Run all examples
 */
export function runAllExamples() {
  console.log("Running Pure Pricing Service Examples\n");

  try {
    testSingleSkuPricing();
    testBatchPricing();
    demonstrateMocking();
    demonstratePerformanceComparison();

    console.log("\n=== All Examples Completed Successfully ===");
  } catch (error) {
    console.error("Example failed:", error);
  }
}

// Uncomment to run examples
// runAllExamples();
