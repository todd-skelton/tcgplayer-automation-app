import {
  categorySetSyncsRepository,
  productsRepository,
  setProductsRepository,
} from "~/core/db";
import {
  getAllProducts,
  getSetProductCounts,
  type Product as SearchProduct,
} from "~/integrations/tcgplayer/client/get-search-results.server";
import {
  fetchAndUpsertCategorySets,
  fetchAndUpsertProductsAndSkus,
} from "~/routes/home.server";
import type { CategorySet } from "~/shared/data-types/categorySet";
import type { ProductLine } from "~/shared/data-types/productLine";
import type { SetProduct } from "~/shared/data-types/setProduct";
import {
  findProductsToFetch,
  findSetProductsToSave,
  findUnstoredProductIds,
  matchListedSets,
  needsSync,
  type ListedSetCount,
  type StoredProduct,
  type StoredSetProduct,
} from "../domain/catalogSyncPlan";
import type {
  CatalogSyncResult,
  SetSyncResult,
} from "../domain/catalogSyncSummary";

export type CatalogSyncDependencies = {
  refreshCategorySets(
    categoryId: number,
  ): Promise<{ sets: CategorySet[]; productLine: ProductLine }>;
  getListedSetCounts(
    productLineUrlName: string,
  ): Promise<{ listedProductCount: number; sets: ListedSetCount[] }>;
  findStoredProductCounts(categoryId: number): Promise<Map<number, number>>;
  findVerifiedProductCounts(categoryId: number): Promise<Map<number, number>>;
  searchSetProducts(
    productLineUrlName: string,
    setUrlName: string,
  ): Promise<SearchProduct[]>;
  findStoredProducts(
    productIds: number[],
    productLineId: number,
  ): Promise<StoredProduct[]>;
  findStoredSetProducts(productIds: number[]): Promise<StoredSetProduct[]>;
  fetchProductsAndSkus(
    setProducts: SetProduct[],
    productLineId: number,
  ): Promise<{ skusInserted: number }>;
  saveSetProducts(setProducts: SetProduct[]): Promise<void>;
  recordVerifiedProductCount(
    setNameId: number,
    productCount: number,
  ): Promise<void>;
};

const defaultDependencies: CatalogSyncDependencies = {
  refreshCategorySets: fetchAndUpsertCategorySets,
  async getListedSetCounts(productLineUrlName) {
    const counts = await getSetProductCounts(productLineUrlName);
    return {
      listedProductCount: counts.totalProductCount,
      sets: counts.sets.map((set) => ({
        urlName: set.urlValue,
        name: set.value,
        productCount: set.count,
      })),
    };
  },
  findStoredProductCounts: (categoryId) =>
    setProductsRepository.countStoredBySet(categoryId),
  findVerifiedProductCounts: (categoryId) =>
    categorySetSyncsRepository.findVerifiedProductCounts(categoryId),
  searchSetProducts: (productLineUrlName, setUrlName) =>
    getAllProducts({
      size: 50,
      filters: {
        term: { productLineName: [productLineUrlName], setName: [setUrlName] },
      },
      sort: { field: "product-sorting-name", order: "asc" },
    }),
  async findStoredProducts(productIds, productLineId) {
    const products = await productsRepository.findByIds(productIds, productLineId);
    return products.map((product) => ({
      productId: product.productId,
      setId: product.setId,
      skuCount: product.skus.length,
    }));
  },
  async findStoredSetProducts(productIds) {
    const setProducts = await setProductsRepository.findByProductIds(productIds);
    return setProducts.map((setProduct) => ({
      productId: setProduct.productId,
      setNameId: setProduct.setNameId,
    }));
  },
  fetchProductsAndSkus: (setProducts, productLineId) =>
    fetchAndUpsertProductsAndSkus(setProducts, productLineId, true),
  saveSetProducts: (setProducts) => setProductsRepository.upsertMany(setProducts),
  recordVerifiedProductCount: (setNameId, productCount) =>
    categorySetSyncsRepository.recordVerifiedProductCount(setNameId, productCount),
};

const productLinesSyncing = new Set<number>();

/**
 * Brings a product line up to date with TCGplayer without walking the whole
 * catalog. One search request reports every set's product count; only sets
 * whose count differs from what is stored (or last verified) are searched,
 * and only their missing or misfiled products are fetched.
 */
export async function syncNewCatalogProducts(
  categoryId: number,
  overrides: Partial<CatalogSyncDependencies> = {},
): Promise<CatalogSyncResult> {
  if (productLinesSyncing.has(categoryId)) {
    throw new Error("A sync is already running for this product line");
  }

  productLinesSyncing.add(categoryId);

  try {
    return await syncProductLine(categoryId, { ...defaultDependencies, ...overrides });
  } finally {
    productLinesSyncing.delete(categoryId);
  }
}

async function syncProductLine(
  categoryId: number,
  dependencies: CatalogSyncDependencies,
): Promise<CatalogSyncResult> {
  const { sets, productLine } = await dependencies.refreshCategorySets(categoryId);
  const [listed, storedCounts, verifiedCounts] = await Promise.all([
    dependencies.getListedSetCounts(productLine.productLineUrlName),
    dependencies.findStoredProductCounts(categoryId),
    dependencies.findVerifiedProductCounts(categoryId),
  ]);
  if (listed.sets.length === 0) {
    throw new Error(
      `TCGplayer search lists no sets for product line "${productLine.productLineUrlName}"`,
    );
  }

  const { matched, unmatched } = matchListedSets(listed.sets, sets);
  const setsToSync = matched
    .map(({ set, listedProductCount }) => ({
      set,
      listedProductCount,
      storedProductCount: storedCounts.get(set.setNameId) ?? 0,
      verifiedProductCount: verifiedCounts.get(set.setNameId) ?? null,
    }))
    .filter(needsSync);

  console.log(
    `[syncNewCatalogProducts] ${productLine.productLineName}: ${setsToSync.length} of ${matched.length} sets changed`,
  );

  const syncedSets: SetSyncResult[] = [];

  for (const [index, counts] of setsToSync.entries()) {
    console.log(
      `[syncNewCatalogProducts] Set ${index + 1}/${setsToSync.length}: ${counts.set.name} (listed ${counts.listedProductCount}, stored ${counts.storedProductCount})`,
    );
    syncedSets.push(
      await syncSet(dependencies, productLine, counts.set, {
        listedProductCount: counts.listedProductCount,
        storedProductCount: counts.storedProductCount,
      }),
    );
  }

  return {
    productLineName: productLine.productLineName,
    listedSetCount: listed.sets.length,
    listedProductCount: listed.listedProductCount,
    uncountedProductCount:
      listed.listedProductCount -
      listed.sets.reduce((total, set) => total + set.productCount, 0),
    syncedSets,
    unmatchedSets: unmatched,
  };
}

async function syncSet(
  dependencies: CatalogSyncDependencies,
  productLine: ProductLine,
  set: CategorySet,
  counts: { listedProductCount: number; storedProductCount: number },
): Promise<SetSyncResult> {
  const result: SetSyncResult = {
    setName: set.name,
    listedProductCount: counts.listedProductCount,
    storedProductCountBefore: counts.storedProductCount,
    newProductCount: 0,
    repairedProductCount: 0,
    skusAdded: 0,
    verified: false,
  };

  try {
    const listedProducts = toSetProducts(
      await dependencies.searchSetProducts(productLine.productLineUrlName, set.urlName),
      set,
      productLine,
    );
    const listedProductIds = listedProducts.map((product) => product.productId);
    const storedBefore = await dependencies.findStoredProducts(
      listedProductIds,
      productLine.productLineId,
    );
    const storedIdsBefore = new Set(storedBefore.map((product) => product.productId));
    const productsToFetch = findProductsToFetch(set.setNameId, listedProducts, storedBefore);

    if (productsToFetch.length > 0) {
      const fetched = await dependencies.fetchProductsAndSkus(
        productsToFetch,
        productLine.productLineId,
      );
      result.skusAdded = fetched.skusInserted;
    }

    const storedProducts = await dependencies.findStoredProducts(
      listedProductIds,
      productLine.productLineId,
    );
    const storedSetProducts = await dependencies.findStoredSetProducts(listedProductIds);
    await dependencies.saveSetProducts(
      findSetProductsToSave(set.setNameId, listedProducts, storedSetProducts, storedProducts),
    );

    const unstoredProductIds = findUnstoredProductIds(
      set.setNameId,
      listedProductIds,
      await dependencies.findStoredSetProducts(listedProductIds),
      await dependencies.findStoredProducts(listedProductIds, productLine.productLineId),
    );
    const unstored = new Set(unstoredProductIds);
    const nowStored = productsToFetch.filter((product) => !unstored.has(product.productId));
    result.newProductCount = nowStored.filter(
      (product) => !storedIdsBefore.has(product.productId),
    ).length;
    result.repairedProductCount = nowStored.length - result.newProductCount;

    if (listedProducts.length !== counts.listedProductCount) {
      result.problem = `Search returned ${listedProducts.length} products but the set count is ${counts.listedProductCount}`;
    } else if (unstoredProductIds.length > 0) {
      result.problem = `${unstoredProductIds.length} listed products could not be stored in this set: ${unstoredProductIds.slice(0, 10).join(", ")}${unstoredProductIds.length > 10 ? ", ..." : ""}`;
    } else {
      await dependencies.recordVerifiedProductCount(set.setNameId, counts.listedProductCount);
      result.verified = true;
    }
  } catch (error) {
    console.error(`[syncNewCatalogProducts] ${set.name} failed:`, error);
    result.problem = error instanceof Error ? error.message : String(error);
  }

  return result;
}

function toSetProducts(
  searchProducts: SearchProduct[],
  set: CategorySet,
  productLine: ProductLine,
): SetProduct[] {
  const byProductId = new Map<number, SetProduct>();

  for (const product of searchProducts) {
    if (byProductId.has(product.productId)) {
      continue;
    }

    byProductId.set(product.productId, {
      setNameId: set.setNameId,
      productId: product.productId,
      game: productLine.productLineName,
      number: product.customAttributes?.number ?? "",
      productName: product.productName,
      rarity: product.rarityName,
      set: product.setName,
      setAbbrv: product.setUrlName,
      type: product.customAttributes?.cardType?.join(", ") ?? "",
    });
  }

  return [...byProductId.values()];
}
