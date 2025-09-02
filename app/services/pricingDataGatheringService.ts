import type {
  SkuPricingData,
  BatchPricingData,
  PurePricingConfig,
} from "../types/pricingData";
import type { PricerSku } from "../types/pricing";
import { getAllLatestSales } from "../tcgplayer/get-latest-sales";
import { categoryFiltersDb, skusDb, productsDb } from "../datastores";
import { SupplyAnalysisService } from "./supplyAnalysisService";
import { DataEnrichmentService } from "./dataEnrichmentService";
import type { Sku } from "../data-types/sku";
import type { Product } from "../data-types/product";

/**
 * Service responsible for gathering ALL data needed for pricing upfront
 * This separates data fetching from pricing logic for better testability
 */
export class PricingDataGatheringService {
  private supplyAnalysisService = new SupplyAnalysisService();
  private enrichmentService = new DataEnrichmentService();

  /**
   * Gather all data needed for a batch of SKUs
   * This is the main entry point that fetches everything upfront
   */
  async gatherBatchData(
    skus: PricerSku[],
    config: PurePricingConfig,
    onProgress?: (current: number, total: number, status: string) => void
  ): Promise<BatchPricingData> {
    const totalSteps = 5; // Major steps in data gathering
    let currentStep = 0;

    const updateProgress = (status: string) => {
      onProgress?.(currentStep, totalSteps, status);
    };

    // Step 1: Gather SKU details and product information
    updateProgress("Fetching SKU and product details...");
    const skuDetailsMap = await this.gatherSkuDetails(skus);
    currentStep++;

    // Step 2: Gather all category filters
    updateProgress("Fetching category filters...");
    const categoryFiltersMap = await this.gatherCategoryFilters(skuDetailsMap);
    currentStep++;

    // Step 3: Gather all sales data in parallel
    updateProgress("Fetching sales data...");
    const salesDataMap = await this.gatherSalesData(
      skuDetailsMap,
      categoryFiltersMap
    );
    currentStep++;

    // Step 4: Gather price points
    updateProgress("Fetching price points...");
    const pricePointsMap = await this.gatherPricePoints(skus);
    currentStep++;

    // Step 5: Gather supply analysis data (if enabled)
    let listingsDataMap: Map<number, any[]> = new Map();
    if (config.enableSupplyAnalysis) {
      updateProgress("Fetching supply analysis data...");
      listingsDataMap = await this.gatherSupplyAnalysisData(
        skuDetailsMap,
        config
      );
    }
    currentStep++;

    // Step 6: Gather product info for display
    updateProgress("Fetching product information...");
    const skuIds = skus.map((s) => s.sku);
    const productInfoMap = await this.enrichmentService.fetchProductDetails(
      skuIds
    );

    // Combine all data into SkuPricingData structures
    updateProgress("Combining data...");
    const skusData: SkuPricingData[] = skus.map((sku) => {
      const skuDetails = skuDetailsMap.get(sku.sku);
      const categoryFilter = categoryFiltersMap.get(sku.sku);
      const sales = salesDataMap.get(sku.sku) || [];
      const listings = listingsDataMap.get(sku.sku);
      const pricePoint = pricePointsMap.get(sku.sku);
      const productInfo = productInfoMap.get(sku.sku);

      if (!skuDetails) {
        throw new Error(`SKU details not found for SKU ${sku.sku}`);
      }

      if (!categoryFilter) {
        throw new Error(`No category filter found for SKU ${sku.sku}`);
      }

      return {
        sku: {
          id: sku.sku,
          productId: skuDetails.productId,
          productLineId: skuDetails.productLineId,
          condition: skuDetails.condition as any,
          language: skuDetails.language,
          variant: skuDetails.variant,
          quantity: sku.quantity,
          addToQuantity: sku.addToQuantity,
          currentPrice: sku.currentPrice,
        },
        sales,
        categoryFilter,
        listings,
        pricePoint,
        productInfo: productInfo
          ? {
              productLine: productInfo.productLine || "",
              setName: productInfo.setName || "",
              productName: productInfo.productName || "",
              condition: productInfo.condition || "",
              variant: productInfo.variant || "",
            }
          : undefined,
      };
    });

    updateProgress("Data gathering complete!");

    return {
      skusData,
      config,
    };
  }

  /**
   * Gather SKU details from the database
   */
  private async gatherSkuDetails(skus: PricerSku[]): Promise<Map<number, Sku>> {
    const result = new Map<number, Sku>();

    // Get all SKU details in parallel
    const skuPromises = skus.map(async (sku) => {
      try {
        const skuDetails = await skusDb.findOne({ id: sku.sku });
        if (skuDetails) {
          result.set(sku.sku, skuDetails);
        }
        return { skuId: sku.sku, details: skuDetails };
      } catch (error) {
        console.warn(`Failed to fetch details for SKU ${sku.sku}:`, error);
        return { skuId: sku.sku, details: null };
      }
    });

    await Promise.all(skuPromises);
    return result;
  }

  /**
   * Gather category filters for all SKUs based on their product line IDs
   */
  private async gatherCategoryFilters(
    skuDetailsMap: Map<number, Sku>
  ): Promise<Map<number, any>> {
    const result = new Map();

    // Get unique product line IDs
    const productLineIds = [
      ...new Set(
        Array.from(skuDetailsMap.values()).map((sku) => sku.productLineId)
      ),
    ];

    // Fetch category filters in parallel
    const categoryFilterPromises = productLineIds.map(async (productLineId) => {
      try {
        const filter = await categoryFiltersDb.findOne({
          categoryId: productLineId,
        });
        return { productLineId, filter };
      } catch (error) {
        console.warn(
          `Failed to fetch category filter for productLineId ${productLineId}:`,
          error
        );
        return { productLineId, filter: null };
      }
    });

    const categoryFilters = await Promise.all(categoryFilterPromises);

    // Map results back to SKUs
    categoryFilters.forEach(({ productLineId, filter }) => {
      if (filter) {
        // Find all SKUs that belong to this product line
        skuDetailsMap.forEach((skuDetails, skuId) => {
          if (skuDetails.productLineId === productLineId) {
            result.set(skuId, filter);
          }
        });
      }
    });

    return result;
  }

  /**
   * Gather sales data for all SKUs in parallel
   */
  private async gatherSalesData(
    skuDetailsMap: Map<number, Sku>,
    categoryFiltersMap: Map<number, any>
  ): Promise<Map<number, any[]>> {
    const result = new Map();

    // Fetch sales data for all SKUs in parallel
    const salesPromises = Array.from(skuDetailsMap.entries()).map(
      async ([skuId, skuDetails]) => {
        try {
          const categoryFilter = categoryFiltersMap.get(skuId);
          if (!categoryFilter) {
            return { sku: skuId, sales: [] };
          }

          // Map string values to IDs for salesOptions using category filter
          const languageId = categoryFilter.languages.find(
            (l: any) => l.name === skuDetails.language
          )?.id;
          const variantId = categoryFilter.variants.find(
            (v: any) => v.name === skuDetails.variant
          )?.id;

          const salesOptions = {
            conditions: [], // Fetch all conditions for Zipf model
            languages: languageId ? [languageId] : [],
            variants: variantId ? [variantId] : [],
            listingType: "ListingWithoutPhotos" as const,
          };

          const sales = await getAllLatestSales(
            { id: skuDetails.productId },
            salesOptions,
            100
          );

          return { sku: skuId, sales };
        } catch (error) {
          console.warn(`Failed to fetch sales for SKU ${skuId}:`, error);
          return { sku: skuId, sales: [] };
        }
      }
    );

    const salesResults = await Promise.all(salesPromises);

    salesResults.forEach(({ sku, sales }) => {
      result.set(sku, sales);
    });

    return result;
  }

  /**
   * Gather price points for bounds checking
   */
  private async gatherPricePoints(
    skus: PricerSku[]
  ): Promise<Map<number, any>> {
    const skuIds = skus.map((s) => s.sku);
    return await this.enrichmentService.fetchPricePointsForPricing(skuIds);
  }

  /**
   * Gather supply analysis data if enabled
   */
  private async gatherSupplyAnalysisData(
    skuDetailsMap: Map<number, Sku>,
    config: PurePricingConfig
  ): Promise<Map<number, any[]>> {
    const result = new Map();

    if (!config.enableSupplyAnalysis) {
      return result;
    }

    // Fetch listings for all SKUs in parallel
    const listingsPromises = Array.from(skuDetailsMap.entries()).map(
      async ([skuId, skuDetails]) => {
        try {
          const listings = await this.supplyAnalysisService.fetchListingsForSku(
            skuDetails,
            config.supplyAnalysisConfig
          );

          return { sku: skuId, listings };
        } catch (error) {
          console.warn(`Failed to fetch listings for SKU ${skuId}:`, error);
          return { sku: skuId, listings: [] };
        }
      }
    );

    const listingsResults = await Promise.all(listingsPromises);

    listingsResults.forEach(({ sku, listings }) => {
      result.set(sku, listings);
    });

    return result;
  }

  /**
   * Validate gathered data before processing
   */
  validateGatheredData(batchData: BatchPricingData): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check that we have data for all SKUs
    if (batchData.skusData.length === 0) {
      errors.push("No SKU data provided");
      return { isValid: false, errors };
    }

    // Validate each SKU's data
    batchData.skusData.forEach((skuData, index) => {
      const sku = skuData.sku.id;

      // Check required fields
      if (!skuData.sku.id || skuData.sku.id <= 0) {
        errors.push(`Invalid SKU ID at index ${index}: ${skuData.sku.id}`);
      }

      if (!skuData.categoryFilter) {
        errors.push(`Missing category filter for SKU ${sku}`);
      }

      if (!skuData.sales || skuData.sales.length === 0) {
        // This is a warning, not an error - the pricing service will handle it
        console.warn(
          `No sales data for SKU ${sku} - pricing may not be accurate`
        );
      }

      // Validate sales data structure
      if (skuData.sales) {
        skuData.sales.forEach((sale, saleIndex) => {
          if (!sale.purchasePrice || sale.purchasePrice <= 0) {
            console.warn(
              `Invalid purchase price for SKU ${sku}, sale ${saleIndex}: ${sale.purchasePrice}`
            );
          }
          if (!sale.orderDate) {
            console.warn(
              `Missing order date for SKU ${sku}, sale ${saleIndex}`
            );
          }
        });
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}
