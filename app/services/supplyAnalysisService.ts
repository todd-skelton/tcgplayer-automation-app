import type { Sku } from "../data-types/sku";
import { getListings } from "../tcgplayer/get-listings";

export interface ListingData {
  price: number;
  shippingCost: number;
  quantity: number;
  sellerId: number;
  isVerified: boolean;
  listingId: number;
}

export interface SupplyAnalysisConfig {
  confidenceWeight?: number; // 0-1, how much to weight supply vs historical (default 0.7)
  maxListingsPerSku?: number; // Performance limit (default 200)
  includeUnverifiedSellers?: boolean; // Include unverified sellers in analysis (default false)
}

export interface SalesVelocityData {
  price: number;
  quantity: number;
  timestamp: number;
}

export interface SupplyQueueAnalysis {
  totalSupplyBelow: number;
  averageQueuePrice: number;
  competitorCount: number;
  queuePosition: number;
}

/**
 * Service for analyzing current market supply and calculating supply-adjusted time to sell
 */
export class SupplyAnalysisService {
  /**
   * Fetch all listings for a SKU with pagination
   */
  async fetchListingsForSku(
    sku: Sku,
    config: SupplyAnalysisConfig = {}
  ): Promise<ListingData[]> {
    const { maxListingsPerSku = 200, includeUnverifiedSellers = false } =
      config;

    let listings: ListingData[] = [];
    let from = 0;
    const pageSize = 50;
    let morePages = true;
    let totalResults = 0;

    try {
      while (morePages && listings.length < maxListingsPerSku) {
        const { results } = await getListings(
          { id: sku.productId },
          {
            filters: {
              term: {
                listingType: ["standard"],
                condition: [sku.condition],
                language: [sku.language],
                printing: [sku.variant],
                "verified-seller": includeUnverifiedSellers ? undefined : true,
              },
            },
            from,
            size: Math.min(pageSize, maxListingsPerSku - listings.length),
            sort: { field: "price+shipping", order: "asc" },
          }
        );

        if (!results || results.length === 0) break;
        const page = results[0];
        if (!page || !page.results || page.results.length === 0) break;

        // Convert to standardized format
        const pageListings: ListingData[] = page.results.map(
          (listing: any) => ({
            price: listing.price || 0,
            shippingCost: listing.sellerShippingPrice || 0,
            quantity: listing.quantity || 0,
            sellerId: listing.sellerId || 0,
            isVerified: listing.isVerifiedSeller || false,
            listingId: listing.listingId || 0,
          })
        );

        listings = listings.concat(pageListings);
        totalResults = page.totalResults;
        from += pageSize;
        morePages =
          listings.length < totalResults && listings.length < maxListingsPerSku;
      }
    } catch (error) {
      console.warn(`Failed to fetch listings for SKU ${sku.sku}:`, error);
      // Return empty array to gracefully degrade to historical method
      return [];
    }

    return listings;
  }

  /**
   * Analyze supply queue position for a given target price
   */
  analyzeSupplyQueue(
    listings: ListingData[],
    targetPrice: number
  ): SupplyQueueAnalysis {
    const belowTarget = listings.filter(
      (l) => l.price + l.shippingCost <= targetPrice
    );

    const totalSupplyBelow = belowTarget.reduce(
      (sum, l) => sum + l.quantity,
      0
    );
    const competitorCount = belowTarget.length;

    let averageQueuePrice = 0;
    if (belowTarget.length > 0) {
      const totalValue = belowTarget.reduce(
        (sum, l) => sum + (l.price + l.shippingCost) * l.quantity,
        0
      );
      const totalQuantity = Math.max(1, totalSupplyBelow);
      averageQueuePrice = totalValue / totalQuantity;
    }

    return {
      totalSupplyBelow,
      averageQueuePrice,
      competitorCount,
      queuePosition: totalSupplyBelow + 1, // +1 for your listing
    };
  }

  /**
   * Calculate sales velocity from historical sales data
   */
  calculateSalesVelocity(
    sales: SalesVelocityData[],
    targetPrice: number
  ): number {
    const relevantSales = sales.filter((s) => s.price >= targetPrice);

    if (relevantSales.length === 0) {
      return 0.1; // Very low velocity if no relevant sales
    }

    const totalQuantity = relevantSales.reduce((sum, s) => sum + s.quantity, 0);
    const timeSpan = this.getTimeSpanInDays(relevantSales);

    if (timeSpan <= 0) {
      return totalQuantity; // All sales happened on same day
    }

    return totalQuantity / timeSpan; // units per day
  }

  /**
   * Calculate supply-adjusted time to sell
   */
  calculateSupplyAdjustedTimeToSell(
    sales: SalesVelocityData[],
    listings: ListingData[],
    targetPrice: number,
    config: SupplyAnalysisConfig = {}
  ): number | undefined {
    const { confidenceWeight = 0.7 } = config;

    if (listings.length === 0) {
      // Fall back to historical method
      return this.calculateHistoricalTimeToSell(sales, targetPrice);
    }

    // Step 1: Calculate historical interval
    const historicalInterval = this.calculateHistoricalTimeToSell(
      sales,
      targetPrice
    );

    // Step 2: Analyze current supply queue
    const queueAnalysis = this.analyzeSupplyQueue(listings, targetPrice);

    // Step 3: Calculate sales velocity
    const salesVelocity = this.calculateSalesVelocity(sales, targetPrice);

    if (salesVelocity <= 0) {
      return historicalInterval;
    }

    // Step 4: Calculate supply-adjusted time
    const supplyAdjustedDays = queueAnalysis.queuePosition / salesVelocity;

    // Step 5: Blend estimates
    if (historicalInterval === undefined || historicalInterval === Infinity) {
      return Math.min(365, supplyAdjustedDays); // Cap at 1 year
    }

    const blendedTime =
      historicalInterval * (1 - confidenceWeight) +
      supplyAdjustedDays * confidenceWeight;

    // Apply reasonable bounds (1 day to 1 year)
    return Math.max(1, Math.min(365, blendedTime));
  }

  /**
   * Calculate historical time to sell (existing algorithm)
   */
  private calculateHistoricalTimeToSell(
    sales: SalesVelocityData[],
    targetPrice: number
  ): number | undefined {
    const relevantSales = sales
      .filter((s) => s.price >= targetPrice)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (relevantSales.length === 0) {
      return Infinity;
    }

    if (relevantSales.length === 1) {
      return 90; // Default for single sale
    }

    // Calculate intervals between sales
    const intervals = [];
    for (let i = 1; i < relevantSales.length; i++) {
      intervals.push(
        (relevantSales[i].timestamp - relevantSales[i - 1].timestamp) /
          (1000 * 60 * 60 * 24)
      );
    }

    // Return median interval
    intervals.sort((a, b) => a - b);
    const mid = Math.floor(intervals.length / 2);
    return intervals.length % 2 !== 0
      ? intervals[mid]
      : (intervals[mid - 1] + intervals[mid]) / 2;
  }

  /**
   * Get time span in days between first and last sale
   */
  private getTimeSpanInDays(sales: SalesVelocityData[]): number {
    if (sales.length <= 1) return 0;

    const timestamps = sales.map((s) => s.timestamp).sort((a, b) => a - b);
    return (
      (timestamps[timestamps.length - 1] - timestamps[0]) /
      (24 * 60 * 60 * 1000)
    );
  }

  /**
   * Batch fetch listings for multiple SKUs with progress tracking
   */
  async fetchListingsForSkus(
    skus: Sku[],
    config: SupplyAnalysisConfig = {},
    onProgress?: (current: number, total: number, status: string) => void
  ): Promise<Map<number, ListingData[]>> {
    const listingsMap = new Map<number, ListingData[]>();

    for (let i = 0; i < skus.length; i++) {
      const sku = skus[i];

      onProgress?.(
        i + 1,
        skus.length,
        `Fetching listings for SKU ${sku.sku}...`
      );

      try {
        const listings = await this.fetchListingsForSku(sku, config);
        listingsMap.set(sku.sku, listings);
      } catch (error) {
        console.warn(`Failed to fetch listings for SKU ${sku.sku}:`, error);
        listingsMap.set(sku.sku, []); // Empty array for failed fetches
      }
    }

    return listingsMap;
  }
}
