/**
 * DEMONSTRATION: Benefits of the New Modular Architecture
 *
 * This file demonstrates how the refactored pricing system provides
 * better separation of concerns and increased modularity.
 */

import { PurePricingService } from "./purePricingService";
import { DataEnrichmentService } from "./dataEnrichmentService";
import { PricingPipelineService } from "./pricingPipelineService";
import { CSVDataSource } from "./csvDataSource";
import { SellerInventoryDataSource } from "./sellerInventoryDataSource";
import { PendingInventoryDataSource } from "./pendingInventoryDataSource";

/**
 * EXAMPLE 1: Fast pricing without enrichment
 * Use case: Quick price calculations for large datasets
 */
export const fastPricingExample = async () => {
  const pricingService = new PurePricingService();

  const skus = [
    { sku: 12345, quantity: 4, currentPrice: 10.5 },
    { sku: 67890, quantity: 2, currentPrice: 25.0 },
  ];

  // This runs FAST - only calculates prices, no extra data fetching
  const result = await pricingService.calculatePrices(skus, {
    percentile: 75,
    onProgress: (progress) => console.log(`Pricing: ${progress.status}`),
  });

  console.log(
    `Priced ${result.stats.processed} items in ${result.stats.processingTime}ms`
  );
};

/**
 * EXAMPLE 2: Pricing with selective enrichment
 * Use case: Display pricing data with only needed supplementary info
 */
export const selectiveEnrichmentExample = async () => {
  const pricingService = new PurePricingService();
  const enrichmentService = new DataEnrichmentService();

  const skus = [{ sku: 12345, quantity: 4 }];

  // Fast pricing first
  const pricingResult = await pricingService.calculatePrices(skus, {
    percentile: 50,
  });

  // Then enrich with display data (can be done in parallel with other operations)
  const enrichedData = await enrichmentService.enrichForDisplay(
    pricingResult.pricedItems
  );

  console.log(`Fast pricing: ${pricingResult.stats.processingTime}ms`);
  console.log(`With enrichment: Full display data available`);
};

/**
 * EXAMPLE 3: Custom pipeline for special requirements
 * Use case: Custom processing workflow
 */
export const customPipelineExample = async () => {
  const pipelineService = new PricingPipelineService();
  const csvDataSource = new CSVDataSource();

  // Mock file
  const mockFile = new File(["mock csv content"], "test.csv");

  // Custom pipeline: pricing only, no enrichment, no export
  const result = await pipelineService.executePipeline(
    csvDataSource,
    { file: mockFile },
    {
      percentile: 90,
      source: "custom-analysis",
      enableEnrichment: false, // Skip enrichment for speed
      enableExport: false, // Skip export - handle data ourselves
    }
  );

  // Process the pricing data with custom logic
  const highValueItems = result.pricedSkus.filter(
    (sku) => (sku.price || 0) > 100
  );
  console.log(`Found ${highValueItems.length} high-value items`);
};

/**
 * EXAMPLE 4: Composable data sources
 * Use case: Different data sources, same processing pipeline
 */
export const composableSourcesExample = async () => {
  const pipelineService = new PricingPipelineService();

  // Process CSV data
  const csvSource = new CSVDataSource();
  const csvFile = new File(["csv content"], "inventory.csv");

  const csvResult = await pipelineService.executePipeline(
    csvSource,
    { file: csvFile },
    {
      percentile: 50,
      source: "csv-upload",
    }
  );

  // Process seller inventory with same pipeline
  const sellerSource = new SellerInventoryDataSource();

  const sellerResult = await pipelineService.executePipeline(
    sellerSource,
    { sellerKey: "ABC123" },
    {
      percentile: 50,
      source: "seller-inventory",
    }
  );

  // Process pending inventory with same pipeline
  const pendingSource = new PendingInventoryDataSource();

  const pendingResult = await pipelineService.executePipeline(
    pendingSource,
    {},
    {
      percentile: 50,
      source: "pending-inventory",
    }
  );

  console.log("All three data sources processed with identical pipeline logic");
};

/**
 * EXAMPLE 5: Parallel processing
 * Use case: Process pricing and fetch supplementary data simultaneously
 */
export const parallelProcessingExample = async () => {
  const pricingService = new PurePricingService();
  const enrichmentService = new DataEnrichmentService();

  const skus = [{ sku: 12345, quantity: 4 }];

  // Start pricing calculation
  const pricingPromise = pricingService.calculatePrices(skus, {
    percentile: 50,
  });

  // Simultaneously prepare enrichment data (could fetch product catalogs, etc.)
  const preparationPromise = enrichmentService.clearCache(); // Example prep work

  // Wait for pricing to complete
  const pricingResult = await pricingPromise;
  await preparationPromise;

  // Now enrich (this will be faster due to preparation)
  const enrichedData = await enrichmentService.enrichForDisplay(
    pricingResult.pricedItems
  );

  console.log("Pricing and preparation ran in parallel for better performance");
};

/**
 * BENEFITS SUMMARY:
 *
 * 1. SEPARATION OF CONCERNS:
 *    - PurePricingService: Only calculates prices
 *    - DataEnrichmentService: Only handles supplementary data
 *    - DataSources: Only handle data fetching and conversion
 *    - Pipeline: Only orchestrates the workflow
 *
 * 2. PERFORMANCE:
 *    - Core pricing runs without waiting for product details
 *    - Can skip enrichment when not needed
 *    - Can run enrichment in parallel
 *
 * 3. TESTABILITY:
 *    - Each service can be unit tested independently
 *    - Mock services easily for different scenarios
 *    - Clear interfaces make testing straightforward
 *
 * 4. FLEXIBILITY:
 *    - Enable/disable enrichment as needed
 *    - Compose different data sources with same pipeline
 *    - Customize workflow for specific use cases
 *
 * 5. MAINTAINABILITY:
 *    - Changes to pricing logic don't affect enrichment
 *    - Changes to data sources don't affect pricing
 *    - Easy to add new data sources or enrichment types
 *
 * 6. REUSABILITY:
 *    - Core pricing service used by all pricers
 *    - Data sources can be used independently
 *    - Pipeline can be reused for new pricing scenarios
 */
