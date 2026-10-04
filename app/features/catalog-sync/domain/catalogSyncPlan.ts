import type { CategorySet } from "~/shared/data-types/categorySet";
import type { SetProduct } from "~/shared/data-types/setProduct";

/** One set's product count, as reported by TCGplayer search. */
export type ListedSetCount = {
  urlName: string;
  name: string;
  productCount: number;
};

export type SetCounts = {
  /** Products TCGplayer lists in the set right now. */
  listedProductCount: number;
  /** Products in the set whose details and SKUs are stored under that set. */
  storedProductCount: number;
  /** TCGplayer's count the last time every listed product was confirmed stored. */
  verifiedProductCount: number | null;
};

/** A stored product, reduced to what sync decisions need. */
export type StoredProduct = {
  productId: number;
  setId: number;
  skuCount: number;
};

/** A stored set product row: which set a product is filed under. */
export type StoredSetProduct = {
  productId: number;
  setNameId: number;
};

/**
 * Pairs TCGplayer's per-set counts with catalog sets by URL name, the identity
 * the search aggregation exposes.
 */
export function matchListedSets(
  listedSets: ListedSetCount[],
  categorySets: CategorySet[],
): {
  matched: Array<{ set: CategorySet; listedProductCount: number }>;
  unmatched: ListedSetCount[];
} {
  const setsByUrlName = new Map(categorySets.map((set) => [set.urlName, set]));
  const matched: Array<{ set: CategorySet; listedProductCount: number }> = [];
  const unmatched: ListedSetCount[] = [];

  for (const listed of listedSets) {
    const set = setsByUrlName.get(listed.urlName);

    if (set) {
      matched.push({ set, listedProductCount: listed.productCount });
    } else {
      unmatched.push(listed);
    }
  }

  return { matched, unmatched };
}

/**
 * A set needs syncing when TCGplayer lists more products than are stored, or
 * when its listed count moved since the last verified sync. Without a verified
 * count the stored count is the baseline, so a set that already matches is
 * skipped. The verified count stops stale extra rows, which keep a stored count
 * above the listed count, from hiding newly listed products.
 */
export function needsSync(counts: SetCounts): boolean {
  const baseline = counts.verifiedProductCount ?? counts.storedProductCount;

  return (
    counts.storedProductCount < counts.listedProductCount ||
    counts.listedProductCount !== baseline
  );
}

/** Listed products whose details or SKUs are missing, or filed under another set. */
export function findProductsToFetch(
  setNameId: number,
  listedProducts: SetProduct[],
  storedProducts: StoredProduct[],
): SetProduct[] {
  const storedById = indexByProductId(storedProducts);

  return listedProducts.filter(
    (listed) => !isStoredInSet(storedById.get(listed.productId), setNameId),
  );
}

/**
 * Listed products whose details confirm this set but whose set product row is
 * missing or points elsewhere. Product details decide set membership, so a
 * product that details place in another set is left alone.
 */
export function findSetProductsToSave(
  setNameId: number,
  listedProducts: SetProduct[],
  storedSetProducts: StoredSetProduct[],
  storedProducts: StoredProduct[],
): SetProduct[] {
  const filedSetById = new Map(
    storedSetProducts.map((stored) => [stored.productId, stored.setNameId]),
  );
  const storedById = indexByProductId(storedProducts);

  return listedProducts.filter(
    (listed) =>
      storedById.get(listed.productId)?.setId === setNameId &&
      filedSetById.get(listed.productId) !== setNameId,
  );
}

/**
 * Listed products not yet stored in this set with their SKUs. Only when this is
 * empty is the listed count safe to remember as verified.
 */
export function findUnstoredProductIds(
  setNameId: number,
  listedProductIds: number[],
  storedSetProducts: StoredSetProduct[],
  storedProducts: StoredProduct[],
): number[] {
  const filedInSet = new Set(
    storedSetProducts
      .filter((stored) => stored.setNameId === setNameId)
      .map((stored) => stored.productId),
  );
  const storedById = indexByProductId(storedProducts);

  return listedProductIds.filter(
    (productId) =>
      !filedInSet.has(productId) ||
      !isStoredInSet(storedById.get(productId), setNameId),
  );
}

function indexByProductId(storedProducts: StoredProduct[]) {
  return new Map(storedProducts.map((stored) => [stored.productId, stored]));
}

function isStoredInSet(product: StoredProduct | undefined, setNameId: number) {
  return product !== undefined && product.setId === setNameId && product.skuCount > 0;
}
