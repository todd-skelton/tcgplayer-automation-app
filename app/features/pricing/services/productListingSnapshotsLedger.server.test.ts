import assert from "node:assert/strict";
import type { ListingSnapshot } from "~/core/db/repositories/productListingSnapshots.server";
import type { Sku } from "~/shared/data-types/sku";
import {
  fetchListingsForProductAndRecord,
  summarizeListingsByCondition,
} from "./productListingSnapshotsLedger.server";
import type { ListingData } from "./supplyAnalysisService";

const sku = {
  productId: 676046,
  variant: "Holofoil",
  language: "English",
  condition: "Near Mint",
} as Sku;

const listing = (
  condition: ListingData["condition"],
  price: number,
  shippingCost: number,
  seller: string,
): ListingData => ({
  condition,
  price,
  shippingCost,
  sellerId: seller,
  sellerKey: seller,
  listingId: price * 100,
});

const listings = [
  listing("Near Mint", 10, 1.49, "a"),
  listing("Near Mint", 9.75, 0, "b"),
  listing("Near Mint", 12, 0, "c"),
  listing("Lightly Played", 9, 0, "a"),
];
const settle = () => new Promise((resolve) => setImmediate(resolve));

assert.deepEqual(summarizeListingsByCondition(sku, listings, "2026-09-05"), [
  {
    productId: 676046,
    variant: "Holofoil",
    language: "English",
    condition: "Near Mint",
    observedOn: "2026-09-05",
    sellerCount: 3,
    cheapestDeliveredPrice: 9.75,
    secondCheapestDeliveredPrice: 11.49,
  },
  {
    productId: 676046,
    variant: "Holofoil",
    language: "English",
    condition: "Lightly Played",
    observedOn: "2026-09-05",
    sellerCount: 1,
    cheapestDeliveredPrice: 9,
    secondCheapestDeliveredPrice: null,
  },
]);
console.log("PASS listings summarize per condition by delivered price");

{
  const recorded: ListingSnapshot[][] = [];
  const result = await fetchListingsForProductAndRecord(sku, {}, {
    fetch: async () => ({ status: "observed", listings }),
    record: async (snapshots) => {
      recorded.push(snapshots);
    },
    now: () => new Date("2026-09-05T15:00:00.000Z"),
  });
  await settle();
  assert.equal(result.listings, listings);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0][0].observedOn, "2026-09-05");
  assert.equal(recorded[0].length, 2);
  console.log("PASS observed listings are returned unchanged and summarized into the ledger");
}

{
  let recordCalls = 0;
  const result = await fetchListingsForProductAndRecord(sku, {}, {
    fetch: async () => ({ status: "unavailable", listings: [] }),
    record: async () => {
      recordCalls += 1;
    },
  });
  await settle();
  assert.equal(result.status, "unavailable");
  assert.equal(recordCalls, 0);
  console.log("PASS an unavailable fetch records no snapshot");
}
