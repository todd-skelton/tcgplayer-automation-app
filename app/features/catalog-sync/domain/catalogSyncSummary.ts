import type { ListedSetCount } from "./catalogSyncPlan";

export type SetSyncResult = {
  setName: string;
  listedProductCount: number;
  storedProductCountBefore: number;
  newProductCount: number;
  repairedProductCount: number;
  skusAdded: number;
  /** Every listed product is stored, so the set is skipped until its listed count changes. */
  verified: boolean;
  problem?: string;
};

export type CatalogSyncResult = {
  productLineName: string;
  listedSetCount: number;
  listedProductCount: number;
  /** Listed products the per-set counts do not account for; sets holding them were not checked. */
  uncountedProductCount: number;
  syncedSets: SetSyncResult[];
  unmatchedSets: ListedSetCount[];
};

export function describeCatalogSync(result: CatalogSyncResult): string {
  const totals = result.syncedSets.reduce(
    (sum, set) => ({
      newProducts: sum.newProducts + set.newProductCount,
      repairedProducts: sum.repairedProducts + set.repairedProductCount,
      skusAdded: sum.skusAdded + set.skusAdded,
    }),
    { newProducts: 0, repairedProducts: 0, skusAdded: 0 },
  );
  const unchangedSetCount =
    result.listedSetCount - result.unmatchedSets.length - result.syncedSets.length;
  const verifiedSetCount = result.syncedSets.filter((set) => set.verified).length;
  const lines = [
    `${result.productLineName}: ${result.listedProductCount} listed products in ${result.listedSetCount} sets.`,
    `Unchanged sets: ${unchangedSetCount}. Synced sets: ${result.syncedSets.length} (verified: ${verifiedSetCount}, not verified: ${result.syncedSets.length - verifiedSetCount}).`,
    `New products: ${totals.newProducts}. New SKUs: ${totals.skusAdded}. Repaired products: ${totals.repairedProducts}.`,
  ];

  if (result.uncountedProductCount !== 0) {
    lines.push(
      `WARNING: per-set counts account for ${result.listedProductCount - result.uncountedProductCount} of ${result.listedProductCount} listed products, so some sets were not checked.`,
    );
  }

  for (const set of result.syncedSets) {
    const changes = [
      `${set.newProductCount} new`,
      set.repairedProductCount > 0 ? `${set.repairedProductCount} repaired` : null,
      `${set.skusAdded} SKUs`,
    ].filter(Boolean);
    const outcome = set.problem ? `NOT VERIFIED: ${set.problem}` : "verified";
    lines.push(
      `- ${set.setName}: ${changes.join(", ")} (listed ${set.listedProductCount}, stored before ${set.storedProductCountBefore}) - ${outcome}`,
    );
  }

  for (const set of result.unmatchedSets) {
    lines.push(
      `- ${set.name}: ${set.productCount} listed products, but TCGplayer's set list has no set with URL name "${set.urlName}" - skipped`,
    );
  }

  return lines.join("\n");
}
