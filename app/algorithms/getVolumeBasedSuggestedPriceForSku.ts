import type { Sku } from "../data-types/sku";
import { getPriceHistory } from "../tcgplayer/get-price-history";
import { getListings } from "../tcgplayer/get-listings";

/**
 * Suggest a price for a given SKU using a rolling window algorithm:
 * - Uses recent sales and current listings data
 * - Considers configurable parameters for window sizes, minimum sales, and pricing probability
 */
export async function getVolumeBasedSuggestedPriceForSku(
  sku: Sku,
  config: RollingWindowConfig = {}
): Promise<SuggestedPriceResult> {
  const {
    targetWindow = 7, // days, preferred window for probability
  } = config;

  // 1. Fetch price history for the last 7 days for this SKU
  const priceHistory = await getPriceHistory({
    id: sku.productId,
    range: "month",
  });
  const skuHistory = priceHistory.result.find(
    (r) => r.skuId === String(sku.sku)
  );
  let medianVolume: number = 0;
  if (skuHistory && skuHistory.buckets && skuHistory.buckets.length > 0) {
    medianVolume = getPercentileVolumeFromBuckets(
      skuHistory.buckets,
      50,
      targetWindow
    );
  }

  // 2. Always get listings
  let listings: any[] = [];
  let from = 0;
  const pageSize = 50;
  let morePages = true;
  let totalResults = 0;
  while (morePages) {
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
    totalResults = page.totalResults;
    from += pageSize;
    morePages = listings.length < totalResults;
  }

  const targetPrice =
    medianVolume > 0
      ? getPriceAtVolumeFromListings(listings, medianVolume)
      : undefined;

  return {
    price: targetPrice ? Math.max(0.01, targetPrice - 0.01) : undefined,
    medianVolume,
  };
}

// Move RollingWindowConfig and SuggestedPriceResult interfaces here
export interface RollingWindowConfig {
  targetWindow?: number; // preferred window for probability
}

export interface SuggestedPriceResult {
  price?: number;
  medianVolume: number;
}

/**
 * Calculate the percentile volume from an array of sales buckets.
 * @param buckets Array of sales buckets (should have quantitySold as string or number)
 * @param percentile Percentile to calculate (0-100, default 50)
 * @param window Number of most recent days to consider (default 7)
 * @returns The percentile volume (e.g., median if 50)
 */
export function getPercentileVolumeFromBuckets(
  buckets: { quantitySold: string | number }[],
  percentile: number = 50,
  window: number = 7
): number {
  if (!buckets || buckets.length === 0) return 0;
  const windowVolume = buckets
    .slice(0, window)
    .map((b) => Number(b.quantitySold) || 0)
    .filter((n) => !isNaN(n));
  if (windowVolume.length === 0) return 0;
  const sorted = [...windowVolume].sort((a, b) => a - b);
  const idx = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/**
 * Find the price at which the running quantity meets or exceeds the target volume.
 * @param listings Array of listings (should have price, sellerShippingPrice, quantity)
 * @param targetVolume The volume to reach
 * @returns The price at the target volume, or undefined if not enough listings
 */
export function getPriceAtVolumeFromListings(
  listings: { price: number; sellerShippingPrice?: number; quantity: number }[],
  targetVolume: number
): number | undefined {
  let runningQty = 0;
  for (const l of listings) {
    runningQty += l.quantity;
    if (runningQty >= targetVolume) {
      return l.price + (l.sellerShippingPrice || 0);
    }
  }
  return undefined;
}
