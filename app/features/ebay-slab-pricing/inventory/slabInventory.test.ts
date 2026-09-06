import assert from "node:assert/strict";
import {
  parseInventoryImport,
  parseListingSnapshot,
  type ListingSnapshot,
} from "./slabInventory";
import { parseInventoryCsv } from "./slabInventoryCsv.server";

export const listingFixture: ListingSnapshot = {
  itemId: "397774081597",
  variationKey: "",
  sku: "duplicate-sku",
  title: "2023 Pokemon Galarian Zapdos SWSH283 PSA 8",
  price: { amount: 16, currency: "USD" },
  shipping: { amount: null, currency: null, policyId: null },
  quantity: 1,
  state: "active",
  format: "fixed-price",
  certificate: { grader: "PSA", certificateNumber: "00123456" },
  expected: {},
  specifics: {},
  reviewReasons: [],
};
assert.equal(
  parseListingSnapshot(listingFixture).certificate?.certificateNumber,
  "00123456",
);
assert.ok(
  parseListingSnapshot({
    ...listingFixture,
    title: "Mixed slab lot",
  }).reviewReasons.includes("unsupported-lot-review-listing"),
);
assert.ok(
  parseListingSnapshot({
    ...listingFixture,
    quantity: 2,
  }).reviewReasons.includes("multiple-items-share-certificate"),
);
assert.throws(() => parseListingSnapshot({ ...listingFixture, quantity: NaN }));
assert.throws(() =>
  parseListingSnapshot({
    ...listingFixture,
    price: { amount: Infinity, currency: "USD" },
  }),
);
const input = {
  seller: "PokeBash",
  source: "ebay" as const,
  observedAt: new Date().toISOString(),
  completeActiveInventory: true,
  listings: [listingFixture],
};
assert.equal(parseInventoryImport(input).seller, "pokebash");
assert.throws(() => parseInventoryImport({ ...input, source: "csv" }));
assert.throws(() =>
  parseInventoryImport({
    ...input,
    listings: [listingFixture, listingFixture],
  }),
);
assert.equal(
  parseInventoryImport({
    ...input,
    listings: [listingFixture, { ...listingFixture, itemId: "397774081600" }],
  }).listings.length,
  2,
);
const header =
  "item_id,title,price,currency,quantity,state,format,grader,certificate_number";
const csv = parseInventoryCsv(
  `${header}\n397774081597,Zapdos,16,USD,1,active,fixed-price,PSA,00123456`,
  "pokebash",
);
assert.equal(csv.listings[0].certificate?.certificateNumber, "00123456");
assert.equal(csv.completeActiveInventory, false);
assert.throws(() =>
  parseInventoryCsv(
    `${header}\n397774081597,Zapdos,,USD,1,active,fixed-price,PSA,00123456`,
    "pokebash",
  ),
);
assert.throws(() =>
  parseInventoryCsv("item_id,title\n397774081597,Zapdos", "pokebash"),
);
assert.throws(() =>
  parseInventoryCsv(
    `${header}\n397774081597,Zapdos,16,USD,1,active,fixed-price,PSA,00123456,extra`,
    "pokebash",
  ),
);
