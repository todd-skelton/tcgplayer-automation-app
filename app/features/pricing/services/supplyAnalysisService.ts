import type { Sku } from "../../../shared/data-types/sku";
import {
  getListings,
  getAllListings,
} from "../../../integrations/tcgplayer/client/get-listings";

export interface ListingData {
  price: number;
  shippingCost: number;
  quantity: number;
  sellerId: number;
  isVerified: boolean;
  listingId: number;
}

export interface SupplyAnalysisConfig {
  maxListingsPerSku?: number; // Performance limit (default 200)
  includeUnverifiedSellers?: boolean; // Include unverified sellers in analysis (default false)
  maxSalesPrice?: number; // Optional: filter listings to prices up to this maximum (optimization)
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
   * Fetch all listings for a SKU with pagination and optional price range optimization
   *
   * Performance optimization: When maxSalesPrice is provided, the getAllListings function
   * will filter results and terminate early when listings exceed that price, reducing
   * unnecessary API calls for irrelevant high-priced listings.
   */
  async fetchListingsForSku(
    sku: Sku,
    config: SupplyAnalysisConfig = {}
  ): Promise<ListingData[]> {
    const {
      maxListingsPerSku = 200,
      includeUnverifiedSellers = false,
      maxSalesPrice,
    } = config;

    try {
      // Use getAllListings with maxPrice optimization
      const allListings = await getAllListings(
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
          size: 50, // Keep reasonable page size
          sort: { field: "price+shipping", order: "asc" },
        },
        maxSalesPrice // This will cause early termination when price exceeds this value
      );

      // Limit to maxListingsPerSku and convert to standardized format
      const limitedListings = allListings.slice(0, maxListingsPerSku);

      const listings: ListingData[] = limitedListings.map((listing: any) => ({
        price: listing.price || 0,
        shippingCost: listing.sellerShippingPrice || 0,
        quantity: listing.quantity || 0,
        sellerId: listing.sellerId || 0,
        isVerified: listing.isVerifiedSeller || false,
        listingId: listing.listingId || 0,
      }));

      return listings;
    } catch (error) {
      console.warn(`Failed to fetch listings for SKU ${sku.sku}:`, error);
      // Return empty array to gracefully degrade to historical method
      return [];
    }
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
  ): number | undefined {
    const relevantSales = sales.filter((s) => s.price >= targetPrice);

    if (relevantSales.length === 0) {
      return undefined; // No relevant sales data available
    }

    const totalQuantity = relevantSales.reduce((sum, s) => sum + s.quantity, 0);
    const timeSpanMs = this.getTimeSpanInMs(relevantSales);

    if (timeSpanMs === 0) {
      return Infinity; // All sales happened at same time = infinite velocity
    }

    return totalQuantity / timeSpanMs; // units per millisecond
  }

  /**
   * Calculate supply-adjusted time to sell with listings count
   */
  calculateSupplyAdjustedTimeToSell(
    sales: SalesVelocityData[],
    listings: ListingData[],
    targetPrice: number,
    historicalSalesVelocityMs?: number
  ): { timeMs: number | undefined; listingsCount: number } {
    if (listings.length === 0) {
      // If no listings available, your listing would be the only one,
      // so use historical sales velocity as the expected time to sell
      return {
        timeMs: historicalSalesVelocityMs,
        listingsCount: 0,
      };
    }

    // Step 1: Analyze current supply queue
    const queueAnalysis = this.analyzeSupplyQueue(listings, targetPrice);

    // Step 2: Calculate sales velocity (units per millisecond)
    const salesVelocity = this.calculateSalesVelocity(sales, targetPrice);

    if (salesVelocity === undefined || salesVelocity <= 0) {
      // If there's no sales velocity at this price point, we don't have enough
      // information to make a reasonable estimate. Return undefined.
      return {
        timeMs: undefined,
        listingsCount: queueAnalysis.competitorCount,
      };
    }

    // Step 3: Calculate supply-adjusted time in milliseconds
    // If sales velocity is Infinity, time to sell is 0 (instant)
    const timeMs =
      salesVelocity === Infinity
        ? 0
        : queueAnalysis.queuePosition / salesVelocity;

    return {
      timeMs,
      listingsCount: queueAnalysis.competitorCount,
    };
  }

  /**
   * Get time span in milliseconds between first and last sale
   */
  private getTimeSpanInMs(sales: SalesVelocityData[]): number {
    if (sales.length <= 1) return 0;

    const timestamps = sales.map((s) => s.timestamp).sort((a, b) => a - b);
    return timestamps[timestamps.length - 1] - timestamps[0];
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
