import assert from "node:assert/strict";
import { PRICING_CONSTANTS } from "~/core/constants/pricing";
import {
  BUYER_CHOICE_CALIBRATION,
  buyerChoiceInputs,
  estimateBuyerChoiceSellDays,
  forecastBuyerChoice,
  type BuyerChoiceInputs,
} from "./buyerChoiceSellTime";

assert.equal(
  BUYER_CHOICE_CALIBRATION.purchaseFixedCost,
  PRICING_CONSTANTS.SMALL_ORDER_SHIPPING_FEE,
  "the fit assumed the store's small-order shipping fee; a fee change needs a refit",
);

const days = (inputs: Partial<BuyerChoiceInputs>, listedPrice = 1_000_000) =>
  estimateBuyerChoiceSellDays(
    { buyerIntervalDays: 1, competingSellers: 0, ...inputs },
    listedPrice,
  )!;

const baseline = days({});
assert.ok(
  days({ buyerIntervalDays: 4 }) > baseline,
  "slower demand sells slower",
);
assert.ok(
  days({ competingSellers: 20 }) > baseline,
  "more sellers sell slower",
);
assert.ok(
  days({}, 0.3) > days({}, 30),
  "a card that is mostly shipping cost sells slower",
);
assert.ok(
  days({ competingSellers: 20 }) <
    days({ competingSellers: 20, buyerIntervalDays: 4 }),
  "demand and competition compound",
);
assert.equal(days({ buyerIntervalDays: 0 }), undefined);
assert.equal(days({ competingSellers: NaN }), undefined);
assert.equal(days({}, 0), undefined);

const flat = estimateBuyerChoiceSellDays(
  { buyerIntervalDays: 2, competingSellers: 9 },
  5,
  {
    ...BUYER_CHOICE_CALIBRATION,
    demandElasticity: 0,
    competitionElasticity: 0,
    effectivePriceElasticity: 0,
  },
);
assert.ok(
  Math.abs(flat! - Math.LN2 / Math.exp(BUYER_CHOICE_CALIBRATION.logDailyRate)) <
    1e-9,
  "zero elasticities leave only the calibrated base rate",
);

const curve = [
  { percentile: 50, price: 12, buyerIntervalDays: 3, listingsCount: 7 },
  { percentile: 5, price: 8, listingsCount: 0 },
  { percentile: 10, price: 9, buyerIntervalDays: 0.5, listingsCount: 1 },
];
assert.deepEqual(
  buyerChoiceInputs(curve),
  { buyerIntervalDays: 0.5, competingSellers: 7 },
  "inputs come from the lowest point with a sale interval and the most sellers on the curve",
);
assert.equal(
  buyerChoiceInputs([{ percentile: 5, price: 8, buyerIntervalDays: 2 }]),
  undefined,
  "unobserved listings leave the competing seller count unknown",
);
assert.equal(
  buyerChoiceInputs([{ percentile: 5, price: 8, listingsCount: 3 }]),
  undefined,
  "no sale interval means no forecast",
);

assert.deepEqual(
  forecastBuyerChoice(curve, 12),
  {
    medianSellDays: estimateBuyerChoiceSellDays(
      { buyerIntervalDays: 0.5, competingSellers: 7 },
      12,
    ),
    calibration: BUYER_CHOICE_CALIBRATION.name,
  },
  "a forecast carries the name of the calibration that produced it",
);
assert.equal(forecastBuyerChoice([], 12), undefined);

console.log(
  "PASS buyer-choice sell time responds to demand, competition, and effective price",
);
