import type { Sku } from "../../../shared/data-types/sku";
import {
  getListings,
  getAllListings,
} from "../../../integrations/tcgplayer/client/get-listings.server";

export interface ListingData {
  price: number;
  shippingCost: number;
  sellerId: string;
  sellerKey: string;
  listingId: number;
}

export interface ListingObservation {
  status: "observed" | "unavailable" | "disabled";
  listings: ListingData[];
}

export interface SupplyAnalysisConfig {
  includeUnverifiedSellers?: boolean;
  maxSalesPrice?: number;
  excludedSellerKey?: string;
}

export class SupplyAnalysisService {
  async fetchLowestListingPrice(
    sku: Sku,
    config: Pick<
      SupplyAnalysisConfig,
      "includeUnverifiedSellers" | "excludedSellerKey"
    > = {},
  ): Promise<number | undefined> {
    try {
      const response = await getListings(
        { id: sku.productId },
        {
          filters: {
            term: {
              listingType: ["standard"],
              condition: [sku.condition],
              language: [sku.language],
              printing: [sku.variant],
              "verified-seller": config.includeUnverifiedSellers
                ? undefined
                : true,
            },
          },
          size: config.excludedSellerKey ? 50 : 1,
          sort: { field: "price+shipping", order: "asc" },
        },
      );
      const listing = response.results[0]?.results.find(
        ({ sellerKey }) => sellerKey !== config.excludedSellerKey,
      );
      if (!listing) {
        return undefined;
      }

      const deliveredPrice =
        (listing.price ?? 0) + (listing.sellerShippingPrice ?? 0);
      return Number.isFinite(deliveredPrice) && deliveredPrice > 0
        ? deliveredPrice
        : undefined;
    } catch (error) {
      console.warn(`Failed to fetch lowest listing for SKU ${sku.sku}:`, error);
      return undefined;
    }
  }

  async fetchListingsForSku(
    sku: Sku,
    config: SupplyAnalysisConfig = {},
  ): Promise<ListingObservation> {
    const {
      includeUnverifiedSellers = false,
      maxSalesPrice,
      excludedSellerKey,
    } = config;

    try {
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
          size: 50,
          sort: { field: "price+shipping", order: "asc" },
        },
        maxSalesPrice,
      );

      const bestOfferBySeller = new Map<string, ListingData>();
      for (const listing of allListings) {
        if (excludedSellerKey && listing.sellerKey === excludedSellerKey)
          continue;
        const normalized: ListingData = {
          price: listing.price || 0,
          shippingCost: listing.sellerShippingPrice || 0,
          sellerId: listing.sellerId || "",
          sellerKey: listing.sellerKey || "",
          listingId: listing.listingId || 0,
        };
        const seller =
          normalized.sellerKey ||
          normalized.sellerId ||
          `listing:${normalized.listingId}`;
        const current = bestOfferBySeller.get(seller);
        if (
          !current ||
          normalized.price + normalized.shippingCost <
            current.price + current.shippingCost
        ) {
          bestOfferBySeller.set(seller, normalized);
        }
      }

      const uniqueSellerOffers = [...bestOfferBySeller.values()].sort(
        (left, right) =>
          left.price + left.shippingCost - (right.price + right.shippingCost),
      );
      return {
        status: "observed",
        listings: uniqueSellerOffers,
      };
    } catch (error) {
      console.warn(`Failed to fetch listings for SKU ${sku.sku}:`, error);
      return { status: "unavailable", listings: [] };
    }
  }

  countCompetingSellers(listings: ListingData[], targetPrice: number): number {
    const bestOfferBySeller = new Map<string, number>();
    for (const listing of listings) {
      const deliveredPrice = listing.price + listing.shippingCost;
      if (deliveredPrice > targetPrice) continue;
      const seller =
        listing.sellerKey || listing.sellerId || `listing:${listing.listingId}`;
      const current = bestOfferBySeller.get(seller);
      if (current === undefined || deliveredPrice < current) {
        bestOfferBySeller.set(seller, deliveredPrice);
      }
    }
    return bestOfferBySeller.size;
  }

  calculateSupplyAdjustedTimeToSell(
    listings: ListingData[],
    targetPrice: number,
    buyerIntervalMs?: number,
  ): {
    timeMs: number | undefined;
    listingsCount: number;
    storeWinShare: number;
  } {
    if (listings.length === 0) {
      return {
        timeMs: buyerIntervalMs ? buyerIntervalMs * Math.LN2 : undefined,
        listingsCount: 0,
        storeWinShare: 1,
      };
    }

    const listingsCount = this.countCompetingSellers(listings, targetPrice);
    const storeWinShare = 1 / (listingsCount + 1);
    if (!(buyerIntervalMs && buyerIntervalMs > 0)) {
      return {
        timeMs: undefined,
        listingsCount,
        storeWinShare,
      };
    }

    return {
      timeMs: (Math.LN2 * buyerIntervalMs) / storeWinShare,
      listingsCount,
      storeWinShare,
    };
  }
}
