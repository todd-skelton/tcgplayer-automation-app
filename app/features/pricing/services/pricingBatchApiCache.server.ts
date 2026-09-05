import type { Sku } from "~/shared/data-types/sku";
import type { GetPriceHistoryResponse } from "~/integrations/tcgplayer/client/get-price-history.server";
import type {
  GetLastSalesRequestParams,
  GetLastestSalesRequestBody,
  Sale,
} from "~/integrations/tcgplayer/client/get-latest-sales.server";
import { fetchListingsForProductAndRecord } from "./productListingSnapshotsLedger.server";
import { fetchLatestSalesAndRecord } from "./productSalesLedger.server";
import { fetchAnnualPriceHistoryAndRecord } from "./productWeeklySalesLedger.server";
import type {
  ListingObservation,
  SupplyAnalysisConfig,
} from "./supplyAnalysisService";
import { SupplyAnalysisService } from "./supplyAnalysisService";

function normalizeForCache(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForCache);
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((normalized, [key, entryValue]) => {
        normalized[key] = normalizeForCache(entryValue);
        return normalized;
      }, {});
  }

  return value;
}

function createCacheKey(value: unknown): string {
  return JSON.stringify(normalizeForCache(value));
}

export class PricingBatchApiCache {
  private latestSalesRequests = new Map<string, Promise<Sale[]>>();
  private priceHistoryRequests = new Map<
    number,
    Promise<GetPriceHistoryResponse | undefined>
  >();
  private listingRequests = new Map<string, Promise<ListingObservation>>();
  private lowestListingPriceRequests = new Map<
    string,
    Promise<number | undefined>
  >();
  private supplyAnalysisService = new SupplyAnalysisService();

  fetchLatestSales(
    params: GetLastSalesRequestParams,
    body: GetLastestSalesRequestBody,
    maxSales?: number,
  ): Promise<Sale[]> {
    const key = createCacheKey({ params, body, maxSales });
    const cached = this.latestSalesRequests.get(key);
    if (cached) {
      return cached;
    }

    const request = fetchLatestSalesAndRecord(params, body, maxSales);
    this.latestSalesRequests.set(key, request);
    return request;
  }

  fetchPriceHistory(
    productId: number,
  ): Promise<GetPriceHistoryResponse | undefined> {
    const cached = this.priceHistoryRequests.get(productId);
    if (cached) {
      return cached;
    }

    const request = fetchAnnualPriceHistoryAndRecord(productId);
    this.priceHistoryRequests.set(productId, request);
    return request;
  }

  /** One listings fetch serves every condition of a product, variant, and language. */
  fetchListingsForProduct(
    sku: Sku,
    config: SupplyAnalysisConfig = {},
  ): Promise<ListingObservation> {
    const key = createCacheKey({
      productId: sku.productId,
      language: sku.language,
      variant: sku.variant,
      config,
    });
    const cached = this.listingRequests.get(key);
    if (cached) {
      return cached;
    }

    const request = fetchListingsForProductAndRecord(sku, config, {
      fetch: (target, options) =>
        this.supplyAnalysisService.fetchListingsForProduct(target, options),
    });
    this.listingRequests.set(key, request);
    return request;
  }

  fetchLowestListingPrice(
    sku: Sku,
    config: Pick<
      SupplyAnalysisConfig,
      "includeUnverifiedSellers" | "excludedSellerKey"
    > = {},
  ): Promise<number | undefined> {
    const key = createCacheKey({
      productId: sku.productId,
      condition: sku.condition,
      language: sku.language,
      variant: sku.variant,
      includeUnverifiedSellers: config.includeUnverifiedSellers,
      excludedSellerKey: config.excludedSellerKey,
    });
    const cached = this.lowestListingPriceRequests.get(key);
    if (cached) {
      return cached;
    }

    const request = this.supplyAnalysisService.fetchLowestListingPrice(
      sku,
      config,
    );
    this.lowestListingPriceRequests.set(key, request);
    return request;
  }
}
