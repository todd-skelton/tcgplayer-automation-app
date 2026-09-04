import assert from "node:assert/strict";
import { BUYER_CHOICE_CALIBRATION } from "~/features/pricing/algorithms/buyerChoiceSellTime";
import type { ForecastGradingRecord } from "../types/inventoryStrategy";
import { loadForecastGrading } from "./forecastGrading.server";

const now = new Date("2026-10-01T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * day);
const row = (
  sku: number,
  daysAgo: number,
  quantity: ForecastGradingRecord["quantity"],
  overrides: Partial<ForecastGradingRecord> = {},
): ForecastGradingRecord => ({
  sku,
  pricedAt: at(daysAgo),
  quantity,
  basis: "modeled",
  method: "profit-per-day",
  curveMedianSellDays: 10,
  buyerChoiceMedianSellDays: 30,
  buyerChoiceCalibration: BUYER_CHOICE_CALIBRATION.name,
  ...overrides,
});

const rows: ForecastGradingRecord[] = [
  // sold: quantity fell within the horizon
  row(1, 30, 2),
  row(1, 20, 1),
  row(1, 1, 1),
  // unsold: priced throughout; a result without a quantity is ignored
  row(2, 30, 1),
  row(2, 15, null),
  row(2, 14, 1),
  row(2, 1, 1),
  // a target-horizon result carries no curve forecast, so the SKU joins at
  // its next result and the earlier quantity drop does not count
  row(3, 40, 2, { method: "target-horizon" }),
  row(3, 30, 1),
  row(3, 1, 1),
  // an earlier calibration is counted but not graded
  row(4, 30, 1, { buyerChoiceCalibration: "older-fit" }),
  row(4, 1, 1, { buyerChoiceCalibration: "older-fit" }),
];
let requestedSince: Date | undefined;
const reports = await loadForecastGrading(
  "seller",
  {
    findForecastGradingRecords: async (_sellerKey, since) => {
      requestedSince = since;
      return rows;
    },
    findInStockSkus: async () => [1, 2, 3, 4],
  },
  now,
);
assert.equal(
  requestedSince?.toISOString(),
  at(56).toISOString(),
  "one query covers two of the longest horizon",
);
assert.deepEqual(
  reports.map((report) => report.horizonDays),
  [14, 21, 28],
);
const report = reports[1]!;
assert.equal(report.cohortSize, 3);
assert.ok(Math.abs(report.soldShare - 1 / 3) < 1e-12);
assert.ok(Math.abs(report.baseRateBrier - 2 / 9) < 1e-12);
assert.equal(report.otherCalibrationCount, 2);
assert.equal(report.curve.deciles.length, 3);
assert.equal(report.buyerChoice.deciles.length, 3);
assert.ok(report.curve.brier > 0 && report.buyerChoice.brier > 0);
assert.equal(
  reports[0]!.cohortSize,
  1,
  "the 14-day cohort holds only the SKU with a graded result 14 to 28 days ago",
);

const empty = await loadForecastGrading(
  "",
  {
    findForecastGradingRecords: async () => {
      throw new Error("must not query without a seller");
    },
    findInStockSkus: async () => [],
  },
  now,
);
assert.deepEqual(
  empty.map((report) => [report.cohortSize, report.curve.deciles]),
  [
    [0, []],
    [0, []],
    [0, []],
  ],
);

console.log(
  "PASS forecast grading reports build from continuous pricing results",
);
