import assert from "node:assert/strict";
import type { Product as SearchProduct } from "~/integrations/tcgplayer/client/get-search-results.server";
import type { CategorySet } from "~/shared/data-types/categorySet";
import { describeCatalogSync } from "../domain/catalogSyncSummary";
import {
  syncNewCatalogProducts,
  type CatalogSyncDependencies,
} from "./syncNewCatalogProducts.server";

const productLine = {
  productLineId: 3, productLineName: "Pokemon", productLineUrlName: "pokemon", isDirect: false,
};

function categorySet(setNameId: number, urlName: string): CategorySet {
  return {
    setNameId, categoryId: 3, name: urlName, cleanSetName: urlName, urlName,
    isSupplemental: false, active: true,
  };
}

function searchProduct(productId: number, setId: number): SearchProduct {
  return {
    productId, setId, productName: `Card ${productId}`, setName: "Set", setUrlName: "Set",
    rarityName: "Common", customAttributes: { number: `${productId}`, cardType: ["Pokemon"] },
  } as SearchProduct;
}

/** An in-memory catalog: TCGplayer's listings on one side, the local tables on the other. */
function fakeCatalog() {
  const sets = [
    categorySet(10, "new-set"),
    categorySet(20, "promo-set"),
    categorySet(30, "unchanged-set"),
    categorySet(40, "broken-details-set"),
    categorySet(50, "short-search-set"),
  ];
  const listings = new Map<string, SearchProduct[]>([
    ["new-set", [searchProduct(101, 10), searchProduct(102, 10)]],
    ["promo-set", [searchProduct(201, 20), searchProduct(202, 20), searchProduct(203, 20)]],
    ["unchanged-set", [searchProduct(301, 30)]],
    ["broken-details-set", [searchProduct(401, 40), searchProduct(402, 40)]],
    ["short-search-set", [searchProduct(501, 50)]],
  ]);
  const listedCounts = new Map([
    ["new-set", 2], ["promo-set", 3], ["unchanged-set", 1],
    ["broken-details-set", 2], ["short-search-set", 2], ["unknown-set", 4],
  ]);
  const products = new Map<number, { setId: number; skuCount: number }>([
    [201, { setId: 20, skuCount: 3 }],
    [202, { setId: 99, skuCount: 3 }],
    [301, { setId: 30, skuCount: 3 }],
  ]);
  const setProducts = new Map<number, number>([[201, 20], [202, 99], [301, 30]]);
  const verified = new Map<number, number>();
  const uncounted = { count: 0 };
  const calls = { searched: [] as string[], fetched: [] as number[] };

  const dependencies: CatalogSyncDependencies = {
    refreshCategorySets: async () => ({ sets, productLine }),
    getListedSetCounts: async () => ({
      listedProductCount: [...listedCounts.values()].reduce((total, count) => total + count, 0) + uncounted.count,
      sets: [...listedCounts].map(([urlName, productCount]) => ({ urlName, name: urlName, productCount })),
    }),
    findStoredProductCounts: async () => {
      const counts = new Map<number, number>();
      for (const [productId, setNameId] of setProducts) {
        const product = products.get(productId);
        if (product?.setId === setNameId && product.skuCount > 0) {
          counts.set(setNameId, (counts.get(setNameId) ?? 0) + 1);
        }
      }
      return counts;
    },
    findVerifiedProductCounts: async () => new Map(verified),
    searchSetProducts: async (_line, setUrlName) => {
      calls.searched.push(setUrlName);
      return listings.get(setUrlName) ?? [];
    },
    findStoredProducts: async (productIds) =>
      productIds.flatMap((productId) => {
        const product = products.get(productId);
        return product ? [{ productId, ...product }] : [];
      }),
    findStoredSetProducts: async (productIds) =>
      productIds.flatMap((productId) => {
        const setNameId = setProducts.get(productId);
        return setNameId === undefined ? [] : [{ productId, setNameId }];
      }),
    fetchProductsAndSkus: async (toFetch) => {
      let skusInserted = 0;
      for (const { productId } of toFetch) {
        calls.fetched.push(productId);
        if (productId === 402) continue;
        const setId = Math.floor(productId / 10);
        const hadProduct = products.has(productId);
        products.set(productId, { setId, skuCount: 3 });
        skusInserted += hadProduct ? 0 : 3;
        if (setProducts.has(productId)) setProducts.set(productId, setId);
      }
      return { skusInserted };
    },
    saveSetProducts: async (toSave) => {
      for (const setProduct of toSave) setProducts.set(setProduct.productId, setProduct.setNameId);
    },
    recordVerifiedProductCount: async (setNameId, productCount) => {
      verified.set(setNameId, productCount);
    },
  };

  return { dependencies, listings, listedCounts, products, setProducts, verified, uncounted, calls };
}

{
  const catalog = fakeCatalog();
  const result = await syncNewCatalogProducts(3, catalog.dependencies);

  assert.deepEqual(
    catalog.calls.searched,
    ["new-set", "promo-set", "unchanged-set", "broken-details-set", "short-search-set"],
    "every set is searched once before its count is trusted",
  );
  assert.deepEqual(
    catalog.calls.fetched.sort(),
    [101, 102, 202, 203, 401, 402, 501],
    "a set whose products are all stored is searched but fetches nothing",
  );
  assert.deepEqual(Object.fromEntries(catalog.verified), { 10: 2, 20: 3, 30: 1 });
  assert.equal(catalog.setProducts.get(101), 10, "new products are filed under their set");
  assert.equal(catalog.setProducts.get(202), 20, "a misfiled product moves to its listed set");
  assert.equal(catalog.setProducts.has(402), false, "a product without details is not filed");

  const bySet = Object.fromEntries(result.syncedSets.map((set) => [set.setName, set]));
  assert.deepEqual(
    [bySet["new-set"].newProductCount, bySet["new-set"].skusAdded, bySet["new-set"].verified],
    [2, 6, true],
  );
  assert.deepEqual(
    [bySet["promo-set"].newProductCount, bySet["promo-set"].repairedProductCount, bySet["promo-set"].storedProductCountBefore],
    [1, 1, 1],
  );
  assert.equal(bySet["broken-details-set"].verified, false);
  assert.match(bySet["broken-details-set"].problem ?? "", /1 listed products could not be stored in this set: 402/);
  assert.equal(bySet["short-search-set"].verified, false);
  assert.match(bySet["short-search-set"].problem ?? "", /Search returned 1 products but the set count is 2/);
  assert.deepEqual(result.unmatchedSets.map((set) => set.urlName), ["unknown-set"]);

  const summary = describeCatalogSync(result);
  assert.match(summary, /^Pokemon: 14 listed products in 6 sets\.\nUnchanged sets: 0\. Synced sets: 5 \(verified: 3, not verified: 2\)\./);
  assert.match(summary, /New products: 5\. New SKUs: 15\. Repaired products: 1\./);
  assert.doesNotMatch(summary, /WARNING/);
  assert.match(summary, /- broken-details-set: 1 new, 3 SKUs .* NOT VERIFIED/);
  assert.match(summary, /- unknown-set: 4 listed products, .* skipped/);
  console.log("PASS a sync fetches only changed sets and verifies only complete ones");

  catalog.calls.searched.length = 0;
  catalog.calls.fetched.length = 0;
  const repeat = await syncNewCatalogProducts(3, catalog.dependencies);
  assert.deepEqual(catalog.calls.searched, ["broken-details-set", "short-search-set"], "verified sets are skipped");
  assert.deepEqual(catalog.calls.fetched, [402], "only the still-missing product is retried");
  assert.equal(repeat.syncedSets.every((set) => !set.verified), true);
  console.log("PASS a repeat sync retries only unverified sets");

  catalog.listings.get("promo-set")!.push(searchProduct(204, 20));
  catalog.listedCounts.set("promo-set", 4);
  catalog.calls.searched.length = 0;
  catalog.calls.fetched.length = 0;
  await syncNewCatalogProducts(3, catalog.dependencies);
  assert.equal(catalog.calls.searched.includes("promo-set"), true);
  assert.deepEqual(catalog.calls.fetched.filter((id) => id < 400), [204], "a grown set fetches only its new product");
  assert.equal(catalog.verified.get(20), 4);
  console.log("PASS a verified set that grows syncs only its new product");

  catalog.uncounted.count = 7;
  const capped = await syncNewCatalogProducts(3, catalog.dependencies);
  assert.equal(capped.uncountedProductCount, 7);
  assert.match(describeCatalogSync(capped), /WARNING: per-set counts account for 15 of 22 listed products/);
  console.log("PASS counts that miss listed products are reported");
}

{
  const catalog = fakeCatalog();
  catalog.dependencies.searchSetProducts = async (_line, setUrlName) => {
    if (setUrlName === "new-set") throw new Error("search unavailable");
    return catalog.listings.get(setUrlName) ?? [];
  };
  const result = await syncNewCatalogProducts(3, catalog.dependencies);
  const failed = result.syncedSets.find((set) => set.setName === "new-set");
  assert.equal(failed?.verified, false);
  assert.equal(failed?.problem, "search unavailable");
  assert.equal(catalog.verified.get(20), 3, "one failing set does not stop the others");
  console.log("PASS a failing set is reported without stopping the sync");
}

{
  const catalog = fakeCatalog();
  catalog.listings.set("unchanged-set", [searchProduct(301, 30), searchProduct(302, 30)]);
  catalog.listedCounts.set("unchanged-set", 2);
  catalog.products.set(399, { setId: 30, skuCount: 3 });
  catalog.setProducts.set(399, 30);
  await syncNewCatalogProducts(3, catalog.dependencies);
  assert.equal(catalog.calls.fetched.includes(302), true, "a stale row cannot hide a listed product that was never stored");
  assert.equal(catalog.verified.get(30), 2);
  assert.equal(catalog.setProducts.get(399), 30, "stale rows are left in place");
  console.log("PASS matching counts do not hide a missing product on the first sync");
}

{
  const catalog = fakeCatalog();
  catalog.dependencies.getListedSetCounts = async () => ({ listedProductCount: 0, sets: [] });
  await assert.rejects(
    syncNewCatalogProducts(3, catalog.dependencies),
    /TCGplayer search lists no sets for product line "pokemon"/,
  );
  console.log("PASS an empty set count response fails instead of reporting nothing to sync");
}

{
  const catalog = fakeCatalog();
  let release = () => {};
  const refreshSets = catalog.dependencies.refreshCategorySets;
  let calls = 0;
  catalog.dependencies.refreshCategorySets = async (categoryId) => {
    calls += 1;
    if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
    return refreshSets(categoryId);
  };
  const first = syncNewCatalogProducts(3, catalog.dependencies);
  await assert.rejects(
    syncNewCatalogProducts(3, catalog.dependencies),
    /A sync is already running for this product line/,
  );
  release();
  await first;
  await syncNewCatalogProducts(3, catalog.dependencies);
  console.log("PASS one product line syncs at a time and frees the slot when done");
}
