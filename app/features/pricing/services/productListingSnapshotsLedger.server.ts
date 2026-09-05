import { productListingSnapshotsRepository } from "~/core/db";
import type { ListingSnapshot } from "~/core/db/repositories/productListingSnapshots.server";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import type { Sku } from "~/shared/data-types/sku";
import {
  SupplyAnalysisService,
  type ListingData,
  type ListingObservation,
  type SupplyAnalysisConfig,
} from "./supplyAnalysisService";

export interface ProductListingSnapshotsLedgerDependencies {
  fetch: (sku: Sku, config: SupplyAnalysisConfig) => Promise<ListingObservation>;
  record: (snapshots: ListingSnapshot[]) => Promise<unknown>;
  now?: () => Date;
}

const defaultService = new SupplyAnalysisService();
const defaultDependencies: ProductListingSnapshotsLedgerDependencies = {
  fetch: (sku, config) => defaultService.fetchListingsForProduct(sku, config),
  record: (snapshots) => productListingSnapshotsRepository.record(snapshots),
};

const delivered = (listing: ListingData) => listing.price + listing.shippingCost;

/** One row per condition: how many sellers ask, and the two cheapest delivered prices. */
export function summarizeListingsByCondition(
  sku: Pick<Sku, "productId" | "variant" | "language">,
  listings: readonly ListingData[],
  observedOn: string,
): ListingSnapshot[] {
  const byCondition = new Map<Condition, number[]>();
  for (const listing of listings) {
    const prices = byCondition.get(listing.condition) ?? [];
    prices.push(delivered(listing));
    byCondition.set(listing.condition, prices);
  }
  return [...byCondition].map(([condition, prices]) => {
    const sorted = [...prices].sort((left, right) => left - right);
    return {
      productId: sku.productId,
      variant: sku.variant ?? "",
      language: sku.language ?? "",
      condition,
      observedOn,
      sellerCount: sorted.length,
      cheapestDeliveredPrice: sorted[0] ?? null,
      secondCheapestDeliveredPrice: sorted[1] ?? null,
    };
  });
}

/**
 * Fetches a product's competing listings and keeps today's summary of them
 * per condition. Pricing already fetches the listings once per product, so
 * the snapshot costs no extra requests; recording is best effort and never
 * delays or fails the price. Only observed listings are recorded: a
 * disabled or failed fetch says nothing about supply.
 */
export async function fetchListingsForProductAndRecord(
  sku: Sku,
  config: SupplyAnalysisConfig = {},
  dependencies: Partial<ProductListingSnapshotsLedgerDependencies> = {},
): Promise<ListingObservation> {
  const { fetch, record, now } = { ...defaultDependencies, ...dependencies };
  const observation = await fetch(sku, config);
  if (observation.status === "observed") {
    const observedOn = (now?.() ?? new Date()).toISOString().slice(0, 10);
    void Promise.resolve()
      .then(() =>
        record(summarizeListingsByCondition(sku, observation.listings, observedOn)),
      )
      .catch((error: unknown) => {
        console.warn(
          `Recording listings for product ${sku.productId} failed`,
          error,
        );
      });
  }
  return observation;
}
