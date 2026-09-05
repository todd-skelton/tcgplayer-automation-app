import assert from "node:assert/strict";
import type { Sale } from "~/integrations/tcgplayer/client/get-latest-sales.server";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import {
  competingAskCeiling,
  fitTimeAwareZipfModelToConditions,
} from "./conditionNormalization";

const asOfTimestamp = Date.parse("2026-09-01T00:00:00.000Z");

function nearMintSale(purchasePrice: number, daysAgo: number): Sale {
  return {
    condition: "Near Mint",
    variant: "Holofoil",
    language: "English",
    quantity: 1,
    title: "",
    listingType: "ListingWithoutPhotos",
    customListingId: "",
    purchasePrice,
    shippingPrice: 0,
    orderDate: new Date(asOfTimestamp - daysAgo * 86_400_000).toISOString(),
  };
}

// Sales in one condition only cannot fit an exponent, so the multipliers come
// from the sibling market prices.
const singleConditionSales = [
  nearMintSale(11, 1),
  nearMintSale(11.5, 3),
  nearMintSale(10.8, 6),
  nearMintSale(11.2, 9),
];
const marketPrices = new Map<Condition, number>([
  ["Near Mint", 11.32],
  ["Lightly Played", 10.63],
  ["Moderately Played", 10.25],
  ["Damaged", 9.24],
]);
const CONDITIONS: Condition[] = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
];

function multipliers(target: Condition, prices = marketPrices) {
  return fitTimeAwareZipfModelToConditions(singleConditionSales, target, {
    asOfTimestamp,
    siblingMarketPrices: prices,
  });
}

const round = (value: number | undefined) =>
  value === undefined ? undefined : Math.round(value * 1000) / 1000;

const heavilyPlayed = multipliers("Heavily Played");
assert.equal(heavilyPlayed.diagnostics.method, "sibling-market-ratio");
assert.equal(heavilyPlayed.diagnostics.anchorCondition, "Moderately Played");
assert.deepEqual(
  [...heavilyPlayed.multipliers].map(([condition, value]) => [condition, round(value)]),
  [
    ["Near Mint", round(10.25 / 11.32)],
    ["Lightly Played", round(10.25 / 10.63)],
    ["Moderately Played", 1],
    ["Heavily Played", 1],
    ["Damaged", round(10.25 / 9.24)],
  ],
);
console.log("PASS a condition without a market price is valued as the nearest better one");

const nearMintOnlyWorse = multipliers(
  "Near Mint",
  new Map<Condition, number>([
    ["Lightly Played", 10.63],
    ["Moderately Played", 10.25],
  ]),
);
assert.equal(nearMintOnlyWorse.diagnostics.anchorCondition, "Lightly Played");
assert.equal(nearMintOnlyWorse.multipliers.get("Lightly Played"), 1);
assert.equal(
  round(nearMintOnlyWorse.multipliers.get("Moderately Played")),
  round(10.63 / 10.25),
);
console.log("PASS without a better neighbour the anchor is the nearest worse one");

const lightlyPlayed = multipliers("Lightly Played");
assert.equal(lightlyPlayed.diagnostics.method, "sibling-market-ratio");
assert.equal(lightlyPlayed.diagnostics.anchorCondition, undefined);
assert.equal(round(lightlyPlayed.multipliers.get("Near Mint")), round(10.63 / 11.32));
console.log("PASS a priced condition is its own anchor");

// The ladder is a property of the card: pricing any condition uses the same
// relative values, so every condition's curve is the one curve rescaled.
const ladders = CONDITIONS.map((target) => multipliers(target).multipliers);
for (const other of CONDITIONS) {
  const ratios = ladders.map(
    (ladder, index) =>
      ladder.get(other)! / ladders[0].get(other)! / (ladder.get("Near Mint")! / ladders[0].get("Near Mint")!),
  );
  // Each target's multipliers are the Near Mint target's, all scaled by one number.
  assert.ok(ratios.every((ratio) => Math.abs(ratio - 1) < 1e-9), `${other} ${ratios}`);
}
console.log("PASS every condition of a card shares one value ladder");

// Market prices that put a worse condition above a better one are pulled down
// to the better one's value, since it rests on far more sales.
const damagedAboveHeavilyPlayed = multipliers(
  "Heavily Played",
  new Map<Condition, number>([
    ["Near Mint", 11.38],
    ["Moderately Played", 10.25],
    ["Damaged", 12],
  ]),
);
assert.equal(damagedAboveHeavilyPlayed.multipliers.get("Damaged"), 1);
assert.equal(
  round(
    multipliers(
      "Near Mint",
      new Map<Condition, number>([
        ["Near Mint", 11.38],
        ["Moderately Played", 10.25],
        ["Damaged", 12],
      ]),
    ).multipliers.get("Damaged"),
  ),
  round(11.38 / 10.25),
);
console.log("PASS a worse condition is never valued above a better one");

const noPrices = multipliers("Heavily Played", new Map());
assert.equal(noPrices.diagnostics.method, "neutral-condition-fallback");
assert.equal(noPrices.multipliers.get("Near Mint"), 1);
console.log("PASS without any sibling price the fallback stays neutral");

// The listings cap is the highest sale in Near Mint terms, so a Damaged sale
// scaled up by the sibling ratio raises it above the raw maximum, and it is
// the same number whichever condition is being priced.
const damagedSale: Sale = { ...nearMintSale(9, 2), condition: "Damaged" };
const ceiling = competingAskCeiling([...singleConditionSales, damagedSale], {
  asOfTimestamp,
  siblingMarketPrices: marketPrices,
});
assert.equal(round(ceiling), round(11.5));
assert.equal(
  competingAskCeiling([damagedSale, nearMintSale(9.5, 1)], {
    asOfTimestamp,
    siblingMarketPrices: marketPrices,
  }),
  Math.ceil(9 * (11.32 / 9.24) * 100) / 100,
);
assert.equal(competingAskCeiling([], { asOfTimestamp }), undefined);
// Without a clock the cap is anchored to the newest sale, so two SKUs of the
// product priced at different moments agree to the cent.
assert.equal(
  competingAskCeiling([...singleConditionSales, damagedSale], {
    siblingMarketPrices: marketPrices,
  }),
  competingAskCeiling([...singleConditionSales, damagedSale], {
    asOfTimestamp: asOfTimestamp - 86_400_000,
    siblingMarketPrices: marketPrices,
  }),
);
console.log("PASS the listings cap is the highest sale in the best condition's terms");
