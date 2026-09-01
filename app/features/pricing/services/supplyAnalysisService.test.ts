import assert from "node:assert/strict";
import { SupplyAnalysisService } from "./supplyAnalysisService";

const service = new SupplyAnalysisService();
const listings = [
  {
    price: 9,
    shippingCost: 1,
    sellerId: "1",
    sellerKey: "seller-1",
    listingId: 1,
  },
  {
    price: 9.5,
    shippingCost: 1,
    sellerId: "1",
    sellerKey: "seller-1",
    listingId: 2,
  },
  {
    price: 10,
    shippingCost: 0,
    sellerId: "2",
    sellerKey: "seller-2",
    listingId: 3,
  },
];

assert.equal(service.countCompetingSellers(listings, 10), 2);

const adjusted = service.calculateSupplyAdjustedTimeToSell(
  listings,
  10,
  5 * 24 * 60 * 60 * 1000,
);
assert.ok(
  Math.abs((adjusted.timeMs ?? 0) - 15 * Math.LN2 * 24 * 60 * 60 * 1000) < 0.01,
);
assert.equal(adjusted.listingsCount, 2);
assert.equal(adjusted.storeWinShare, 1 / 3);

console.log("PASS supply adjustment counts observed seller choices once");
