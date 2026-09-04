import assert from "node:assert/strict";
import { PERCENTILES } from "~/core/constants/pricing";
import type { Sale } from "~/integrations/tcgplayer/client/get-latest-sales.server";
import { getSuggestedPriceFromSales } from "./getSuggestedPriceFromLatestSales";
import { getEffectiveSalePrice } from "./getEffectiveSalePrice";
import {
  fitTimeAwareZipfModelToConditions,
  normalizeSalesToTargetCondition,
} from "./conditionNormalization";

function createSale(
  quantity: number,
  purchasePrice: number,
  shippingPrice = 0,
  condition: Sale["condition"] = "Unopened",
  orderDate = "2026-08-22T00:00:00.000Z",
): Sale {
  return {
    condition,
    variant: "Normal",
    language: "English",
    quantity,
    title: "",
    listingType: "ListingWithoutPhotos",
    customListingId: "",
    purchasePrice,
    shippingPrice,
    orderDate,
  };
}

for (const quantity of [1, 2, 6, 10]) {
  assert.equal(
    getEffectiveSalePrice(createSale(quantity, 5.39)),
    5.39,
    `quantity ${quantity} preserves the per-unit purchase price`,
  );
}

assert.equal(
  getEffectiveSalePrice(createSale(2, 5.39, 1)),
  5.89,
  "order shipping is allocated across the purchased units",
);

assert.equal(
  getEffectiveSalePrice(createSale(0, 5.39, 1)),
  6.39,
  "invalid quantities fall back to one unit",
);

assert.equal(
  getEffectiveSalePrice(createSale(10, 4.99, 1)),
  4.99,
  "order shipping below the free-shipping threshold is not treated as card price",
);

assert.deepEqual(
  PERCENTILES,
  Array.from({ length: 19 }, (_, index) => 5 + index * 5),
  "standard pricing curves cover 5th through 95th in five-point steps",
);

const temporallyMatchedSales = [
  ...Array.from({ length: 8 }, (_, index) =>
    createSale(
      1,
      100 + index / 10,
      0,
      "Near Mint",
      `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    ),
  ),
  createSale(1, 80, 0, "Lightly Played", "2026-06-04T00:00:00.000Z"),
  createSale(1, 200, 0, "Near Mint", "2026-08-24T00:00:00.000Z"),
  ...Array.from({ length: 8 }, (_, index) =>
    createSale(
      1,
      160 + index / 10,
      0,
      "Lightly Played",
      `2026-08-${String(index + 20).padStart(2, "0")}T00:00:00.000Z`,
    ),
  ),
];
const timeAwareNormalization = fitTimeAwareZipfModelToConditions(
  temporallyMatchedSales,
  "Near Mint",
  {
    asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime(),
  },
);
assert.equal(timeAwareNormalization.diagnostics.method, "time-controlled-zipf");
assert.equal(timeAwareNormalization.diagnostics.conditionTimeConnected, true);
assert.ok(
  Math.abs(
    (timeAwareNormalization.multipliers.get("Lightly Played") ?? 0) - 1.25,
  ) < 0.04,
  "nearby cross-condition sales recover the condition ratio despite a changing market level",
);
const normalizedSales = normalizeSalesToTargetCondition(
  temporallyMatchedSales,
  timeAwareNormalization.multipliers,
);
assert.equal(normalizedSales.length, temporallyMatchedSales.length);
for (let index = 0; index < temporallyMatchedSales.length; index += 1) {
  const sale = temporallyMatchedSales[index];
  const expectedMultiplier =
    timeAwareNormalization.multipliers.get(sale.condition) ?? 1;
  assert.equal(
    normalizedSales[index].price,
    getEffectiveSalePrice(sale) * expectedMultiplier,
    "the one fitted current-condition coefficient is applied to every sale",
  );
}
const noCrossConditionPairs = fitTimeAwareZipfModelToConditions(
  temporallyMatchedSales.filter((sale) => sale.condition === "Near Mint"),
  "Near Mint",
  { asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime() },
);

assert.equal(
  noCrossConditionPairs.diagnostics.method,
  "neutral-condition-fallback",
  "a single-condition history falls back instead of manufacturing temporal evidence",
);

const underdeterminedConditionHistory = fitTimeAwareZipfModelToConditions(
  [
    createSale(1, 100, 0, "Near Mint", "2026-08-01T00:00:00.000Z"),
    createSale(1, 1, 0, "Lightly Played", "2026-08-10T00:00:00.000Z"),
    createSale(1, 100, 0, "Near Mint", "2026-08-20T00:00:00.000Z"),
  ],
  "Near Mint",
  { asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime() },
);
assert.equal(
  underdeterminedConditionHistory.diagnostics.method,
  "neutral-condition-fallback",
  "a single observation cannot establish a condition coefficient",
);
assert.equal(
  underdeterminedConditionHistory.multipliers.get("Lightly Played"),
  1,
  "an underdetermined history uses condition equality instead of importing a biased prior from older products",
);
assert.equal(underdeterminedConditionHistory.diagnostics.observationCount, 2);
assert.equal(
  underdeterminedConditionHistory.diagnostics.observedConditionCount,
  1,
);

const siblingFallback = fitTimeAwareZipfModelToConditions(
  [
    createSale(1, 100, 0, "Near Mint", "2026-08-01T00:00:00.000Z"),
    createSale(1, 1, 0, "Lightly Played", "2026-08-10T00:00:00.000Z"),
    createSale(1, 100, 0, "Near Mint", "2026-08-20T00:00:00.000Z"),
  ],
  "Near Mint",
  {
    asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime(),
    siblingMarketPrices: new Map([
      ["Near Mint", 20],
      ["Lightly Played", 16],
      ["Damaged", 5],
    ]),
  },
);
assert.equal(siblingFallback.diagnostics.method, "sibling-market-ratio");
assert.equal(
  siblingFallback.multipliers.get("Lightly Played"),
  1.25,
  "an underdetermined history scales each condition by the sibling market ratio",
);
assert.equal(siblingFallback.multipliers.get("Damaged"), 4);
assert.equal(
  siblingFallback.multipliers.get("Moderately Played"),
  1,
  "a condition without a market price is left as it is",
);
const boundedSiblings = fitTimeAwareZipfModelToConditions(
  [
    createSale(1, 100, 0, "Lightly Played", "2026-08-01T00:00:00.000Z"),
    createSale(1, 1, 0, "Near Mint", "2026-08-10T00:00:00.000Z"),
  ],
  "Lightly Played",
  {
    asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime(),
    siblingMarketPrices: new Map([
      ["Near Mint", 5],
      ["Lightly Played", 20],
      ["Damaged", 0.01],
    ]),
  },
);
assert.equal(
  boundedSiblings.multipliers.get("Near Mint"),
  1,
  "a better condition priced below the target does not scale it down",
);
assert.equal(
  boundedSiblings.multipliers.get("Damaged"),
  25,
  "a stale penny price cannot scale a sale beyond the fitted exponent's reach",
);

const timeConfoundedSales = [
  ...Array.from({ length: 10 }, (_, index) =>
    createSale(
      1,
      100,
      0,
      "Near Mint",
      `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    ),
  ),
  ...Array.from({ length: 10 }, (_, index) =>
    createSale(
      1,
      200,
      0,
      "Lightly Played",
      `2026-08-${String(index + 11).padStart(2, "0")}T00:00:00.000Z`,
    ),
  ),
];
const confoundedNormalization = fitTimeAwareZipfModelToConditions(
  timeConfoundedSales,
  "Near Mint",
  { asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime() },
);
assert.equal(confoundedNormalization.diagnostics.conditionTimeConnected, false);
assert.equal(
  confoundedNormalization.diagnostics.method,
  "neutral-condition-fallback",
);
assert.equal(confoundedNormalization.diagnostics.observationCount, 20);

const reverseConfoundedNormalization = fitTimeAwareZipfModelToConditions(
  [
    ...Array.from({ length: 10 }, (_, index) =>
      createSale(
        1,
        200,
        0,
        "Near Mint",
        `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      ),
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      createSale(
        1,
        100,
        0,
        "Lightly Played",
        `2026-08-${String(index + 11).padStart(2, "0")}T00:00:00.000Z`,
      ),
    ),
  ],
  "Near Mint",
  { asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime() },
);
assert.ok(
  (reverseConfoundedNormalization.diagnostics.conditionExponent ?? 1) < 0.1,
  "a declining market cannot be converted into a condition coefficient when condition and time are confounded",
);
assert.ok(
  Math.abs(
    (reverseConfoundedNormalization.multipliers.get("Lightly Played") ?? 0) - 1,
  ) < 0.1,
);

const selectionBiasedNormalization = fitTimeAwareZipfModelToConditions(
  Array.from({ length: 10 }, (_, index) => [
    createSale(
      1,
      100,
      0,
      "Near Mint",
      `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    ),
    createSale(
      1,
      200,
      0,
      "Lightly Played",
      `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    ),
  ]).flat(),
  "Near Mint",
  { asOfTimestamp: new Date("2026-08-31T00:00:00.000Z").getTime() },
);
assert.equal(
  selectionBiasedNormalization.diagnostics.conditionExponent,
  0,
  "selection-biased LP sales cannot create an LP premium over NM",
);
const orderedNormalizationFactors = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
].map(
  (condition) =>
    selectionBiasedNormalization.multipliers.get(
      condition as Sale["condition"],
    ) ?? 0,
);
assert.deepEqual(
  orderedNormalizationFactors,
  [...orderedNormalizationFactors].sort((left, right) => left - right),
  "normalization-to-NM factors must never imply a lower condition is worth more",
);

const curve = getSuggestedPriceFromSales(
  [
    { price: 1, quantity: 1, timestamp: Date.now() - 86_400_000 },
    { price: 2, quantity: 1, timestamp: Date.now() },
  ],
  {
    percentile: 73,
    halfLifeDays: 7,
    supplyObservation: { status: "observed", listings: [] },
  },
);
assert.ok(
  Math.abs(
    (curve.estimatedTimeToSellMs ?? 0) -
      (curve.historicalSalesVelocityMs ?? 0) * Math.LN2,
  ) < 2,
  "the no-competition sell-time forecast is the median of the buyer-arrival distribution",
);
assert.deepEqual(
  curve.percentiles.map(({ percentile }) => percentile),
  [...PERCENTILES, 73].sort((left, right) => left - right),
  "pricing preserves a custom target alongside the standard exact curve",
);

const unavailableSupplyCurve = getSuggestedPriceFromSales(
  [
    { price: 1, quantity: 1, timestamp: Date.now() - 86_400_000 },
    { price: 2, quantity: 1, timestamp: Date.now() },
  ],
  {
    percentile: 73,
    halfLifeDays: 7,
    supplyObservation: { status: "unavailable", listings: [] },
  },
);
assert.equal(unavailableSupplyCurve.estimatedTimeToSellMs, undefined);
assert.equal(
  unavailableSupplyCurve.percentiles[0]?.supplyStatus,
  "unavailable",
  "missing listing evidence cannot masquerade as zero competition",
);

console.log(
  "PASS latest-sales pricing preserves shipping and time-aware condition normalization",
);
