import assert from "node:assert/strict";
import type { CategorySet } from "~/shared/data-types/categorySet";
import type { SetProduct } from "~/shared/data-types/setProduct";
import {
  findProductsToFetch,
  findSetProductsToSave,
  findUnstoredProductIds,
  matchListedSets,
  needsSync,
} from "./catalogSyncPlan";

function categorySet(setNameId: number, urlName: string): CategorySet {
  return {
    setNameId, categoryId: 3, name: urlName, cleanSetName: urlName, urlName,
    isSupplemental: false, active: true,
  };
}

function listed(productId: number, setNameId = 10): SetProduct {
  return {
    setNameId, productId, game: "Pokemon", number: "", productName: `Card ${productId}`,
    rarity: "", set: "Set", setAbbrv: "set", type: "",
  };
}

{
  const { matched, unmatched } = matchListedSets(
    [
      { urlName: "me06-delta-reign", name: "ME06: Delta Reign", productCount: 21 },
      { urlName: "renamed-away", name: "Gone", productCount: 3 },
    ],
    [categorySet(24831, "me06-delta-reign")],
  );
  assert.deepEqual(matched.map((match) => [match.set.setNameId, match.listedProductCount]), [[24831, 21]]);
  assert.deepEqual(unmatched.map((set) => set.urlName), ["renamed-away"]);
  console.log("PASS listed set counts pair with catalog sets by URL name");
}

{
  const sync = (listedProductCount: number, storedProductCount: number, verifiedProductCount: number | null) =>
    needsSync({ listedProductCount, storedProductCount, verifiedProductCount });

  assert.equal(sync(21, 0, null), true, "a new set syncs");
  assert.equal(sync(66, 44, null), true, "a growing promo set syncs");
  assert.equal(sync(109, 109, null), false, "a matching set is skipped without a verified count");
  assert.equal(sync(891, 893, null), true, "stale extra rows sync once so new products cannot hide behind them");
  assert.equal(sync(891, 893, 891), false, "a verified set with stale extras is skipped while its count holds");
  assert.equal(sync(892, 893, 891), true, "growth behind stale extras still syncs");
  assert.equal(sync(890, 893, 891), true, "a shrinking listed count re-verifies the set");
  assert.equal(sync(109, 108, 109), true, "a verified set that lost stored products syncs");
  console.log("PASS sets sync only when counts show missing or changed products");
}

{
  const products = [listed(1), listed(2), listed(3), listed(4), listed(5)];
  const stored = [
    { productId: 1, setId: 10, skuCount: 5 },
    { productId: 2, setId: 99, skuCount: 5 },
    { productId: 3, setId: 10, skuCount: 0 },
    { productId: 5, setId: 10, skuCount: 2 },
  ];

  assert.deepEqual(
    findProductsToFetch(10, products, stored).map((product) => product.productId),
    [2, 3, 4],
    "missing, misfiled, and SKU-less products are fetched; stored products are not",
  );
  assert.deepEqual(
    findSetProductsToSave(
      10,
      products,
      [{ productId: 1, setNameId: 10 }, { productId: 2, setNameId: 99 }, { productId: 5, setNameId: 77 }],
      stored,
    ).map((product) => product.productId),
    [3, 5],
    "rows are saved only where details confirm the set and the row is missing or elsewhere",
  );
  assert.deepEqual(
    findUnstoredProductIds(
      10,
      [1, 2, 3, 4, 5],
      [{ productId: 1, setNameId: 10 }, { productId: 2, setNameId: 10 }, { productId: 3, setNameId: 10 }, { productId: 5, setNameId: 77 }],
      stored,
    ),
    [2, 3, 4, 5],
    "only a product filed in the set with details in the set and SKUs counts as stored",
  );
  console.log("PASS set changes fetch and file only what is missing or misplaced");
}
