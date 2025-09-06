import type { PricedSku, PricerSku } from "../../core/types/pricing";
import type { PricingResult } from "../../features/pricing/services/pricingCalculator";
import { createDisplayName } from "../../core/utils/displayNameUtils";
import {
  getPricePoints,
  type PricePoint,
} from "../../integrations/tcgplayer/client/get-price-points";

export interface ProductDisplayInfo {
  sku: number;
  productLine?: string;
  setName?: string;
  productName?: string;
  condition?: string;
  variant?: string;
}

export interface MarketDisplayInfo {
  sku: number;
  lowestSalePrice?: number;
  highestSalePrice?: number;
  saleCount?: number;
  tcgMarketPrice?: number;
}

/**
 * Service responsible for enriching pricing data with supplementary information
 * needed for display and output purposes. Runs separately from core pricing.
 */
export class DataEnrichmentService {
  private productDetailCache: Map<number, ProductDisplayInfo> = new Map();
  private marketDataCache: Map<number, MarketDisplayInfo> = new Map();

  /**
   * Fetches price points for SKUs before pricing - uses API endpoint for client-side compatibility
   */
  async fetchPricePointsForPricing(
    skuIds: number[],
    onProgress?: (current: number, total: number, status: string) => void
  ): Promise<Map<number, PricePoint>> {
    const result = new Map<number, PricePoint>();

    if (skuIds.length === 0) {
      return result;
    }

    onProgress?.(
      0,
      skuIds.length,
      "Fetching price points for bounds checking..."
    );

    try {
      // Use API endpoint instead of calling getPricePoints directly
      const requestBody = { skuIds };
      const response = await fetch("/api/price-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        console.warn(`Failed to fetch price points: ${response.status}`);
        return result;
      }

      const data = await response.json();

      if (data.pricePoints && Array.isArray(data.pricePoints)) {
        // Map price points by SKU ID for easy lookup
        data.pricePoints.forEach((pricePoint: any) => {
          result.set(pricePoint.skuId || pricePoint.sku, {
            skuId: pricePoint.skuId || pricePoint.sku,
            marketPrice: pricePoint.marketPrice,
            lowestPrice: pricePoint.lowestPrice,
            highestPrice: pricePoint.highestPrice,
            priceCount: pricePoint.priceCount,
            calculatedAt: pricePoint.calculatedAt,
          });
        });
      }

      onProgress?.(
        skuIds.length,
        skuIds.length,
        "Price points fetched successfully!"
      );

      console.log(
        `Fetched ${result.size} price points for ${skuIds.length} SKUs`
      );
    } catch (error) {
      console.warn("Failed to fetch price points:", error);
      // Continue without price points - bounds checking will be skipped
    }

    return result;
  }

  /**
   * Enriches pricing data with all supplementary information
   */
  async enrichForDisplay(
    pricedItems: PricingResult[],
    onProgress?: (current: number, total: number, status: string) => void
  ): Promise<PricedSku[]>;

  /**
   * Enriches pricing data with all supplementary information, using pre-fetched price points
   */
  async enrichForDisplay(
    pricedItems: PricingResult[],
    onProgress?: (current: number, total: number, status: string) => void,
    pricePointsMap?: Map<number, PricePoint>,
    productLineIdHints?: number[],
    originalPricerSkus?: PricerSku[]
  ): Promise<PricedSku[]>;

  /**
   * Enriches pricing data with all supplementary information
   */
  async enrichForDisplay(
    pricedItems: PricingResult[],
    onProgress?: (current: number, total: number, status: string) => void,
    pricePointsMap?: Map<number, PricePoint>,
    productLineIdHints?: number[],
    originalPricerSkus?: PricerSku[]
  ): Promise<PricedSku[]> {
    const skuIds = pricedItems.map((item) => item.sku);

    console.log("DataEnrichmentService: Starting enrichment for SKUs:", skuIds);

    // Extract productLineId hints from original PricerSku data if available
    let finalProductLineIdHints = productLineIdHints;
    if (!finalProductLineIdHints && originalPricerSkus) {
      finalProductLineIdHints = Array.from(
        new Set(
          originalPricerSkus
            .filter((sku) => sku.productLineId !== undefined)
            .map((sku) => sku.productLineId!)
        )
      );
      if (finalProductLineIdHints.length > 0) {
        console.log(
          "DataEnrichmentService: Extracted productLineId hints from PricerSku data:",
          finalProductLineIdHints
        );
      }
    }

    onProgress?.(0, skuIds.length, "Fetching product details...");

    // If price points are provided, skip fetching market data and use the provided data
    let marketDataPromise: Promise<Map<number, MarketDisplayInfo>>;

    if (pricePointsMap && pricePointsMap.size > 0) {
      console.log(
        "DataEnrichmentService: Using pre-fetched price points, skipping market data fetch"
      );
      // Convert price points to market display info
      marketDataPromise = Promise.resolve(
        this.convertPricePointsToMarketData(pricePointsMap, skuIds)
      );
    } else {
      console.log(
        "DataEnrichmentService: No pre-fetched price points, fetching market data"
      );
      marketDataPromise = this.fetchMarketData(skuIds);
    }

    // Fetch product details in parallel with market data
    const [productDetails, marketData] = await Promise.all([
      this.fetchProductDetails(
        skuIds,
        onProgress,
        finalProductLineIdHints,
        originalPricerSkus
      ),
      marketDataPromise,
    ]);

    console.log(
      "DataEnrichmentService: Product details received:",
      productDetails
    );
    console.log("DataEnrichmentService: Market data received:", marketData);

    onProgress?.(skuIds.length, skuIds.length, "Enrichment complete!");

    // Combine all data
    return pricedItems.map((pricedItem) => {
      const productInfo = productDetails.get(pricedItem.sku);
      const marketInfo = marketData.get(pricedItem.sku);

      const enrichedSku: PricedSku = {
        sku: pricedItem.sku,
        quantity: pricedItem.quantity,
        addToQuantity: pricedItem.addToQuantity,
        previousPrice: pricedItem.previousPrice,
        suggestedPrice: pricedItem.suggestedPrice,
        price: pricedItem.price,
        historicalSalesVelocityDays: pricedItem.historicalSalesVelocityDays,
        estimatedTimeToSellDays: pricedItem.estimatedTimeToSellDays,
        salesCountForHistorical: pricedItem.salesCountForHistorical,
        listingsCountForEstimated: pricedItem.listingsCountForEstimated,
        errors: pricedItem.errors,
        warnings: pricedItem.warnings,

        // Product details
        productLine: productInfo?.productLine,
        setName: productInfo?.setName,
        productName: productInfo?.productName,
        condition: productInfo?.condition,
        variant: productInfo?.variant,

        // Market data
        lowestSalePrice: marketInfo?.lowestSalePrice,
        highestSalePrice: marketInfo?.highestSalePrice,
        saleCount: marketInfo?.saleCount,
        tcgMarketPrice: marketInfo?.tcgMarketPrice,
      };

      console.log(
        `DataEnrichmentService: Enriched SKU ${pricedItem.sku}:`,
        enrichedSku
      );

      return enrichedSku;
    });
  }

  /**
   * Fetches product details for display purposes only
   */
  async fetchProductDetails(
    skuIds: number[],
    onProgress?: (current: number, total: number, status: string) => void,
    productLineIdHints?: number[],
    originalPricerSkus?: PricerSku[]
  ): Promise<Map<number, ProductDisplayInfo>> {
    const result = new Map<number, ProductDisplayInfo>();

    console.log("fetchProductDetails: Starting with SKU IDs:", skuIds);

    // Filter out cached items
    const uncachedSkuIds = skuIds.filter(
      (id) => !this.productDetailCache.has(id)
    );

    console.log("fetchProductDetails: Uncached SKU IDs:", uncachedSkuIds);

    if (uncachedSkuIds.length === 0) {
      // All items are cached
      skuIds.forEach((id) => {
        const cached = this.productDetailCache.get(id);
        if (cached) result.set(id, cached);
      });
      console.log("fetchProductDetails: All items cached, returning:", result);
      return result;
    }

    try {
      // Create the productLineSkus object structure for the new API
      const productLineSkus: { [key: string]: number[] } = {};

      // Try to map SKUs to product lines using originalPricerSkus if available
      if (originalPricerSkus && originalPricerSkus.length > 0) {
        const skuToProductLineMap = new Map<number, number>();
        originalPricerSkus.forEach((pricerSku) => {
          if (pricerSku.productLineId) {
            skuToProductLineMap.set(pricerSku.sku, pricerSku.productLineId);
          }
        });

        // Group uncached SKUs by their product lines
        uncachedSkuIds.forEach((skuId) => {
          const productLineId = skuToProductLineMap.get(skuId);
          if (productLineId) {
            const key = productLineId.toString();
            if (!productLineSkus[key]) {
              productLineSkus[key] = [];
            }
            productLineSkus[key].push(skuId);
          } else if (productLineIdHints && productLineIdHints.length === 1) {
            // If we don't have specific mapping but only one product line hint, use it
            const key = productLineIdHints[0].toString();
            if (!productLineSkus[key]) {
              productLineSkus[key] = [];
            }
            productLineSkus[key].push(skuId);
          }
        });
      } else if (productLineIdHints && productLineIdHints.length === 1) {
        // Fallback: if we have exactly one product line hint, assume all SKUs belong to it
        const key = productLineIdHints[0].toString();
        productLineSkus[key] = uncachedSkuIds;
      }

      // Check if we successfully grouped all SKUs
      const groupedSkuCount = Object.values(productLineSkus).reduce(
        (sum, skus) => sum + skus.length,
        0
      );
      if (groupedSkuCount < uncachedSkuIds.length) {
        console.warn(
          `fetchProductDetails: Could not map all SKUs to product lines. Mapped: ${groupedSkuCount}, Total: ${uncachedSkuIds.length}. Some SKUs may not be fetched.`
        );
      }

      if (Object.keys(productLineSkus).length === 0) {
        console.warn(
          "fetchProductDetails: No SKUs could be mapped to product lines. Cannot fetch product details."
        );
        return result;
      }

      console.log(
        "fetchProductDetails: Grouped SKUs by product line:",
        productLineSkus
      );

      const response = await fetch("/api/inventory/skus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productLineSkus }),
      });

      console.log("fetchProductDetails: Response status:", response.status);

      if (!response.ok) {
        console.warn(`Failed to fetch product details: ${response.status}`);
        return result;
      }

      const data = await response.json();
      console.log("fetchProductDetails: Response data:", data);

      if (Array.isArray(data)) {
        console.log(
          "fetchProductDetails: Processing SKUs array with length:",
          data.length
        );
        data.forEach((skuData: any, index: number) => {
          console.log(
            `fetchProductDetails: Processing SKU ${index + 1}:`,
            skuData
          );
          onProgress?.(
            index + 1,
            data.length,
            `Loading product details... (${index + 1}/${data.length})`
          );

          const productInfo: ProductDisplayInfo = {
            sku: skuData.sku,
            productLine: skuData.productLineName,
            setName: skuData.setName,
            productName: createDisplayName(
              skuData.originalProductName || skuData.productName,
              skuData.cardNumber,
              skuData.rarityName,
              skuData.variant,
              skuData.language
            ),
            condition: skuData.condition,
            variant: skuData.variant,
          };

          console.log(
            `fetchProductDetails: Created product info for SKU ${skuData.sku}:`,
            productInfo
          );

          // Cache the result
          this.productDetailCache.set(productInfo.sku, productInfo);
          result.set(productInfo.sku, productInfo);
        });
      } else {
        console.log("fetchProductDetails: Response is not an array");
      }
    } catch (error) {
      console.error("Failed to fetch product details:", error);
      console.error(
        "Error details:",
        error instanceof Error ? error.message : String(error)
      );
    }

    // Add cached results for all requested SKUs
    skuIds.forEach((id) => {
      const cached = this.productDetailCache.get(id);
      if (cached && !result.has(id)) {
        result.set(id, cached);
      }
    });

    console.log("fetchProductDetails: Final result map:", result);
    return result;
  }

  /**
   * Fetches market data for display purposes - calls API endpoint for client-side usage
   */
  private async fetchMarketData(
    skuIds: number[]
  ): Promise<Map<number, MarketDisplayInfo>> {
    const result = new Map<number, MarketDisplayInfo>();

    console.log(
      "DataEnrichmentService: Starting fetchMarketData for SKUs:",
      skuIds
    );

    // Filter out cached items
    const uncachedSkuIds = skuIds.filter((id) => !this.marketDataCache.has(id));

    console.log("DataEnrichmentService: Uncached SKU IDs:", uncachedSkuIds);

    if (uncachedSkuIds.length === 0) {
      // All items are cached
      skuIds.forEach((id) => {
        const cached = this.marketDataCache.get(id);
        if (cached) result.set(id, cached);
      });
      console.log(
        "DataEnrichmentService: All market data cached, returning:",
        result
      );
      return result;
    }

    try {
      // Call the API endpoint (server-side) instead of getPricePoints directly
      const requestBody = { skuIds: uncachedSkuIds };
      console.log(
        "DataEnrichmentService: Sending request to /api/price-points with body:",
        requestBody
      );

      const response = await fetch("/api/price-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      console.log("DataEnrichmentService: Response status:", response.status);

      if (!response.ok) {
        console.warn(`Failed to fetch market data: ${response.status}`);
        const errorText = await response.text();
        console.warn("Error response:", errorText);
        return result;
      }

      const data = await response.json();
      console.log("DataEnrichmentService: Response data:", data);

      if (data.pricePoints && Array.isArray(data.pricePoints)) {
        data.pricePoints.forEach((pricePoint: any) => {
          const marketInfo: MarketDisplayInfo = {
            sku: pricePoint.skuId || pricePoint.sku,
            lowestSalePrice: pricePoint.lowestPrice,
            highestSalePrice: pricePoint.highestPrice,
            saleCount: pricePoint.priceCount || pricePoint.saleCount || 0,
            tcgMarketPrice: pricePoint.marketPrice,
          };

          console.log(
            `DataEnrichmentService: Processing price point for SKU ${marketInfo.sku}:`,
            pricePoint,
            "→",
            marketInfo
          );

          // Cache the result
          this.marketDataCache.set(marketInfo.sku, marketInfo);
          result.set(marketInfo.sku, marketInfo);
        });
      } else {
        console.log(
          "DataEnrichmentService: No pricePoints array found in response:",
          data
        );
        console.log(
          "DataEnrichmentService: Response keys:",
          Object.keys(data || {})
        );
      }
    } catch (error) {
      console.warn("Failed to fetch market data:", error);
      console.error(
        "Error details:",
        error instanceof Error ? error.message : String(error)
      );
    }

    // Add cached results for all requested SKUs
    skuIds.forEach((id) => {
      const cached = this.marketDataCache.get(id);
      if (cached && !result.has(id)) {
        result.set(id, cached);
      }
    });

    console.log("DataEnrichmentService: Final market data result:", result);
    return result;
  }

  /**
   * Converts pre-fetched price points to market display info format
   */
  private convertPricePointsToMarketData(
    pricePointsMap: Map<number, PricePoint>,
    skuIds: number[]
  ): Map<number, MarketDisplayInfo> {
    const result = new Map<number, MarketDisplayInfo>();

    skuIds.forEach((skuId) => {
      // Check cache first
      const cached = this.marketDataCache.get(skuId);
      if (cached) {
        result.set(skuId, cached);
        return;
      }

      // Convert from price point if available
      const pricePoint = pricePointsMap.get(skuId);
      if (pricePoint) {
        const marketInfo: MarketDisplayInfo = {
          sku: pricePoint.skuId,
          lowestSalePrice: pricePoint.lowestPrice,
          highestSalePrice: pricePoint.highestPrice,
          saleCount: pricePoint.priceCount || 0,
          tcgMarketPrice: pricePoint.marketPrice,
        };

        // Cache the result
        this.marketDataCache.set(skuId, marketInfo);
        result.set(skuId, marketInfo);

        console.log(
          `DataEnrichmentService: Converted price point for SKU ${skuId}:`,
          pricePoint,
          "→",
          marketInfo
        );
      }
    });

    console.log(
      "DataEnrichmentService: Converted price points to market data:",
      result
    );
    return result;
  }

  /**
   * Clear caches if needed
   */
  clearCache(): void {
    this.productDetailCache.clear();
    this.marketDataCache.clear();
  }
}
