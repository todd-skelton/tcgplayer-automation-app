import assert from "node:assert/strict";
import { normalizeListingsToTargetCondition } from "../algorithms/conditionNormalization";
import { SupplyAnalysisService, type ListingData } from "./supplyAnalysisService";

const service = new SupplyAnalysisService();
const listings: ListingData[] = [
  {
    condition: "Near Mint",
    price: 9,
    shippingCost: 1,
    sellerId: "1",
    sellerKey: "seller-1",
    listingId: 1,
  },
  {
    condition: "Near Mint",
    price: 9.5,
    shippingCost: 1,
    sellerId: "1",
    sellerKey: "seller-1",
    listingId: 2,
  },
  {
    condition: "Near Mint",
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

// A Lightly Played listing competes with the card's asks in every condition
// once they are expressed in Lightly Played terms: a Near Mint ask scales
// down and competes at or below its own price, a Moderately Played ask scales
// up and competes only once it is cheap enough to be worth the downgrade.
const productListings: ListingData[] = [
  {
    condition: "Near Mint",
    price: 10.61,
    shippingCost: 0,
    sellerId: "nm",
    sellerKey: "seller-nm",
    listingId: 10,
  },
  {
    condition: "Moderately Played",
    price: 9.5,
    shippingCost: 0,
    sellerId: "mp",
    sellerKey: "seller-mp",
    listingId: 11,
  },
  {
    condition: "Lightly Played",
    price: 10.99,
    shippingCost: 0,
    sellerId: "lp",
    sellerKey: "seller-lp",
    listingId: 12,
  },
];
const ontoLightlyPlayed = new Map<ListingData["condition"], number>([
  ["Near Mint", 0.9],
  ["Lightly Played", 1],
  ["Moderately Played", 1.1],
]);
const normalized = normalizeListingsToTargetCondition(
  productListings,
  ontoLightlyPlayed,
);

assert.deepEqual(
  normalized.map((listing) => [listing.condition, Number(listing.price.toFixed(3))]),
  [
    ["Near Mint", 9.549],
    ["Moderately Played", 10.45],
    ["Lightly Played", 10.99],
  ],
);
// At $10.00 only the Near Mint copy undercuts a Lightly Played listing.
assert.equal(service.countCompetingSellers(normalized, 10), 1);
// At $10.61 the Moderately Played copy is cheap enough to compete too.
assert.equal(service.countCompetingSellers(normalized, 10.61), 2);
// At $10.99 every seller of the card competes.
assert.equal(service.countCompetingSellers(normalized, 10.99), 3);
// Without multipliers the asks stay in their own terms.
assert.equal(
  service.countCompetingSellers(normalizeListingsToTargetCondition(productListings), 10),
  1,
);

console.log("PASS competing sellers pool every condition of the card");
