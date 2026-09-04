import assert from "node:assert/strict";
import {
  CONDITION_RATE_METHOD,
  estimateConditionSaleRate,
  forecastConditionRate,
} from "./conditionSaleRate";

const day = 24 * 60 * 60 * 1000;
const asOfTimestamp = new Date("2026-09-04T12:00:00.000Z").getTime();
const weeks = (transactionsByWeeksAgo: Record<number, number>) =>
  Array.from({ length: 52 }, (_, weeksAgo) => ({
    bucketStartDate: new Date(asOfTimestamp - weeksAgo * 7 * day)
      .toISOString()
      .slice(0, 10),
    transactionCount: String(transactionsByWeeksAgo[weeksAgo] ?? 0),
  }));
const close = (actual: number | undefined, expected: number, message: string) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-9,
    `${message}: ${actual} vs ${expected}`,
  );

const steady = estimateConditionSaleRate(
  weeks({ 1: 2, 5: 1, 9: 3, 20: 2, 30: 2, 45: 2 }),
  { asOfTimestamp },
);
assert.equal(steady?.transactions, 12);
assert.equal(steady?.method, CONDITION_RATE_METHOD);
close(
  steady?.intervalDays,
  1 / ((12 / 364 + 6 / 91) / 2),
  "the interval is the inverse of the mean of the yearly and quarterly rates",
);

const fresh = estimateConditionSaleRate(weeks({ 1: 2, 3: 1, 40: 5 }), {
  asOfTimestamp,
  availableSinceTimestamp: asOfTimestamp - 30 * day,
});
assert.equal(fresh?.transactions, 3, "sales before release are not counted");
close(
  fresh?.intervalDays,
  10,
  "both windows start at the release date when it is more recent",
);

const straddling = estimateConditionSaleRate(
  [{ bucketStartDate: "2026-08-23", transactionCount: 3 }],
  { asOfTimestamp, availableSinceTimestamp: asOfTimestamp - 10 * day },
);
close(
  straddling?.intervalDays,
  10 / 3,
  "a bucket that started before the window still counts its sales over the window's days",
);

assert.equal(
  estimateConditionSaleRate(weeks({}), { asOfTimestamp }),
  undefined,
  "no sales in the year gives no rate",
);
assert.equal(
  estimateConditionSaleRate(weeks({ 0: 4 }), {
    asOfTimestamp,
    availableSinceTimestamp: asOfTimestamp - 3 * day,
  }),
  undefined,
  "a window under a week gives no rate",
);
assert.equal(
  estimateConditionSaleRate(
    [{ bucketStartDate: "2027-01-01", transactionCount: 9 }],
    { asOfTimestamp },
  ),
  undefined,
  "buckets after the as-of moment are ignored",
);

const forecast = forecastConditionRate(steady, 0.5);
close(
  forecast?.medianSellDays,
  (Math.LN2 * (steady?.intervalDays ?? 0)) / 0.5,
  "the forecast is the median wait at the store's win share",
);
assert.equal(forecast?.method, CONDITION_RATE_METHOD);
assert.equal(forecastConditionRate(steady, 0), undefined);
assert.equal(forecastConditionRate(steady, undefined), undefined);
assert.equal(forecastConditionRate(undefined, 0.5), undefined);

console.log(
  "PASS condition sale rate blends a year and a quarter of own sales",
);
