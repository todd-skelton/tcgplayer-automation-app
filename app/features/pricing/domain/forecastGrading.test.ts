import assert from "node:assert/strict";
import {
  buildCohort,
  gradeForecast,
  saleProbability,
  type ForecastRecord,
} from "./forecastGrading";

const day = 24 * 60 * 60 * 1000;
const record = (
  sku: number,
  dayIndex: number,
  quantity: number,
  forecasts: Record<string, number> = { curve: 10, choice: 20 },
): ForecastRecord => ({ sku, pricedAt: dayIndex * day, quantity, forecasts });

const records = [
  // 1: quantity drops on day 5 -> sold
  record(1, 0, 2),
  record(1, 5, 1),
  record(1, 30, 1),
  // 2: priced throughout, never drops -> unsold
  ...[0, 10, 20, 30].map((d) => record(2, d, 1)),
  // 3: vanishes after day 3 and is out of stock -> sold
  record(3, 0, 1),
  record(3, 3, 1),
  // 4: vanishes after day 3 but is still in stock -> censored out
  record(4, 0, 1),
  record(4, 3, 1),
  // 5: joins late, no room for a full horizon -> not in cohort
  record(5, 20, 1),
  record(5, 30, 1),
  // 6: first record lacks a forecast; joins at day 2
  record(6, 0, 1, { curve: 10 }),
  record(6, 2, 1),
  record(6, 30, 1),
  // 7: drops only after the horizon -> unsold, with a slower curve forecast
  record(7, 0, 3, { curve: 40, choice: 20 }),
  record(7, 25, 2, { curve: 40, choice: 20 }),
  record(7, 30, 2, { curve: 40, choice: 20 }),
  // 8: last priced a day before its horizon ends, in stock -> unsold, not censored
  record(8, 0, 1),
  record(8, 20, 1),
];
const cohort = buildCohort(
  records,
  ["curve", "choice"],
  new Set([2, 4, 6, 7, 8]),
  21,
);
assert.deepEqual(
  cohort.map(({ sku, sold }) => [sku, sold]),
  [
    [1, true],
    [2, false],
    [3, true],
    [6, false],
    [7, false],
    [8, false],
  ],
  "cohort membership and outcomes follow the quantity, stock, and horizon rules",
);

assert.ok(
  Math.abs(saleProbability(21, 21) - 0.5) < 1e-12,
  "the median sells half the time",
);

const grade = gradeForecast(cohort, "curve", 21);
assert.equal(grade.count, 6);
assert.ok(Math.abs(grade.soldShare - 2 / 6) < 1e-12);
const fast = saleProbability(10, 21);
const slow = saleProbability(40, 21);
assert.ok(
  Math.abs(
    grade.brier - (2 * (1 - fast) ** 2 + 3 * fast ** 2 + slow ** 2) / 6,
  ) < 1e-12,
  "Brier is the mean squared gap between forecast probability and outcome",
);
assert.deepEqual(
  grade.deciles.map((decile) => decile.count),
  [1, 1, 1, 1, 1, 1],
  "small cohorts still split into one member per decile",
);
assert.deepEqual(
  grade.deciles.map((decile) => decile.medianDays),
  [10, 10, 10, 10, 10, 40],
  "deciles run from the fastest forecast to the slowest",
);
assert.equal(grade.deciles.at(-1)?.soldShare, 0);
assert.ok(Math.abs(grade.deciles.at(-1)!.expectedShare - slow) < 1e-12);

console.log("PASS forecast grading scores forecasts against realized sales");
