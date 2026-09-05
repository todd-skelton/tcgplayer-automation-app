import type { Sku } from "../../../shared/data-types/sku";
import { DISPLAY_CONDITION_ORDER } from "../../../core/utils/conditionOrder";
import type { Condition } from "../../../integrations/tcgplayer/types/Condition";
import {
  getListings,
  getAllListings,
} from "../../../integrations/tcgplayer/client/get-listings.server";

export interface ListingData {
  condition: Condition;
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
  /** Delivered price beyond which listings are not fetched. */
  maxSalesPrice?: number;
  excludedSellerKey?: string;
}

const KNOWN_CONDITIONS = new Set<string>(DISPLAY_CONDITION_ORDER);

function sellerOf(
  listing: Pick<ListingData, "sellerKey" | "sellerId" | "listingId">,
): string {
  return listing.sellerKey || listing.sellerId || `listing:${listing.listingId}`;
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

  /**
   * Each seller's cheapest ask in each condition of the SKU's product, variant,
   * and language, cheapest delivered first. Buyers want the card and weigh
   * condition against price, so a listing competes with asks in every
   * condition once they are expressed in its own condition's terms.
   */
  async fetchListingsForProduct(
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

      const cheapestAskBySellerAndCondition = new Map<string, ListingData>();
      for (const listing of allListings) {
        if (excludedSellerKey && listing.sellerKey === excludedSellerKey)
          continue;
        if (!KNOWN_CONDITIONS.has(listing.condition)) continue;
        const ask: ListingData = {
          condition: listing.condition as Condition,
          price: listing.price || 0,
          shippingCost: listing.sellerShippingPrice || 0,
          sellerId: listing.sellerId || "",
          sellerKey: listing.sellerKey || "",
          listingId: listing.listingId || 0,
        };
        const key = `${sellerOf(ask)} ${ask.condition}`;
        const current = cheapestAskBySellerAndCondition.get(key);
        if (
          !current ||
          ask.price + ask.shippingCost < current.price + current.shippingCost
        ) {
          cheapestAskBySellerAndCondition.set(key, ask);
        }
      }

      return {
        status: "observed",
        listings: [...cheapestAskBySellerAndCondition.values()].sort(
          (left, right) =>
            left.price + left.shippingCost - (right.price + right.shippingCost),
        ),
      };
    } catch (error) {
      console.warn(
        `Failed to fetch listings for product ${sku.productId} (${sku.variant}, ${sku.language}):`,
        error,
      );
      return { status: "unavailable", listings: [] };
    }
  }

  /** Sellers with an ask delivered at or below the price, each counted once. */
  countCompetingSellers(listings: ListingData[], targetPrice: number): number {
    const sellers = new Set<string>();
    for (const listing of listings) {
      if (listing.price + listing.shippingCost <= targetPrice) {
        sellers.add(sellerOf(listing));
      }
    }
    return sellers.size;
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
