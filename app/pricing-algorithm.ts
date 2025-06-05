import type { Sku } from "./data-types/sku";
import { getListings } from "./tcgplayer/get-listings";
import { getPriceHistory } from "./tcgplayer/get-price-history";

/**
 * Configurable rolling window pricing algorithm:
 * - Tries to use the most recent window (e.g., 7 days), then expands if not enough sales
 * - Window sizes and minimum sales required are configurable
 */
export interface RollingWindowConfig {
  targetWindow?: number; // preferred window for probability
}

/**
 * Suggested price result interface
 */
export interface SuggestedPriceResult {
  price?: number;
  medianVolume: number;
}

/**
 * Suggest a price for a given SKU using a rolling window algorithm:
 * - Uses recent sales and current listings data
 * - Considers configurable parameters for window sizes, minimum sales, and pricing probability
 */
export async function getSuggestedPriceForSku(
  sku: Sku,
  config: RollingWindowConfig = {}
): Promise<SuggestedPriceResult> {
  const {
    targetWindow = 7, // days, preferred window for probability
  } = config;
  // 1. Fetch price history for the last 7 days for this SKU
  let medianVolume: number = 0;

  const priceHistory = await getPriceHistory({
    id: sku.productId,
    range: "month",
  });
  // Find the matching SKU entry
  const skuHistory = priceHistory.result.find(
    (r) => r.skuId === String(sku.sku)
  );
  if (skuHistory && skuHistory.buckets && skuHistory.buckets.length > 0) {
    // Get last x days' buckets (already sorted by date descending from API)
    const windowVolume = skuHistory.buckets
      .slice(0, targetWindow)
      .map((b) => Number(b.quantitySold) || 0)
      .filter((n) => !isNaN(n));
    if (windowVolume.length > 0) {
      const sorted = [...windowVolume].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianVolume =
        sorted.length % 2 !== 0
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }

  // Always get listings
  let listings: any[] = [];
  let from = 0;
  const pageSize = 50;
  let runningQty = 0;
  let targetPrice: number | null = null;
  let morePages = true;
  while (morePages && targetPrice === null) {
    const { results } = await getListings(
      { id: sku.productId },
      {
        filters: {
          term: {
            listingType: ["standard"],
            condition: [sku.condition],
            language: [sku.language],
            printing: [sku.variant],
            "verified-seller": true,
          },
        },
        from,
        size: pageSize,
        sort: { field: "price+shipping", order: "asc" },
      }
    );
    if (!results || results.length === 0) break;
    const page = results[0];
    if (!page || !page.results || page.results.length === 0) break;
    listings = listings.concat(page.results);
    for (const l of page.results) {
      runningQty += l.quantity;
      if (runningQty >= medianVolume) {
        targetPrice = l.price + (l.sellerShippingPrice || 0);
        break;
      }
    }
    from += pageSize;
    morePages = listings.length < page.totalResults && targetPrice === null;
  }

  return {
    price: targetPrice ? Math.max(0.01, targetPrice - 0.01) : undefined,
    medianVolume,
  };
}
