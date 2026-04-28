import type { Sku } from "~/shared/data-types/sku";
import {
  getAllLatestSales,
  type GetLastSalesRequestParams,
  type GetLastestSalesRequestBody,
  type Sale,
} from "~/integrations/tcgplayer/client/get-latest-sales.server";
import type {
  ListingData,
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
  private listingRequests = new Map<string, Promise<ListingData[]>>();
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

    const request = getAllLatestSales(params, body, maxSales);
    this.latestSalesRequests.set(key, request);
    return request;
  }

  fetchListingsForSku(
    sku: Sku,
    config: SupplyAnalysisConfig = {},
  ): Promise<ListingData[]> {
    const key = createCacheKey({
      productId: sku.productId,
      condition: sku.condition,
      language: sku.language,
      variant: sku.variant,
      config,
    });
    const cached = this.listingRequests.get(key);
    if (cached) {
      return cached;
    }

    const request = this.supplyAnalysisService.fetchListingsForSku(sku, config);
    this.listingRequests.set(key, request);
    return request;
  }
}
