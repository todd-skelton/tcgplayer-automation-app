import assert from "node:assert/strict";
import type { InventoryStrategyHurdleScenario } from "../types/inventoryStrategy";
import type { ForecastEvaluationReport } from "~/features/pricing/domain/forecastEvaluation";
import { gradingStatus, hurdleReturns } from "./verdict";

const scenario = (
  dailyReturnHurdle: number,
  physicalValue: number,
  medianDays: number | null,
): InventoryStrategyHurdleScenario => ({
  dailyReturnHurdle,
  configured: dailyReturnHurdle === 0.005,
  oneCopyValue: physicalValue,
  physicalValue,
  modeledSkuCount: 1,
  raisedCount: 0,
  loweredCount: 0,
  heldCount: 0,
  estimatedTime:
    medianDays === null
      ? null
      : { medianDays, p75Days: medianDays * 2, p90Days: medianDays * 3 },
});
const economics = {
  costBasisShareOfMarket: 0.5,
  costBasisDiscountPerUnit: 0,
  relativeOverhead: 0,
  staticOverheadPerUnit: 0,
  turnaroundDays: 0,
};
const returns = hurdleReturns(
  [
    scenario(0.0025, 200, 100),
    scenario(0.005, 180, 40),
    scenario(0.01, 150, 10),
    scenario(0.02, 40, 1),
    scenario(0.03, 120, null),
  ],
  { marketValue: 200, unitCount: 1 },
  economics,
);
assert.deepEqual(
  returns.map(({ scenario }) => scenario.dailyReturnHurdle),
  [0.01, 0.005, 0.0025],
  "hurdles rank by cycle return, and one that loses money or has no wait drops out",
);
assert.ok(
  Math.abs(returns[0].dailyReturn - Math.log(150 / 100) / 10) < 1e-12,
  "the return grows the cost basis to the value over the median wait",
);

const report = (models: ForecastEvaluationReport["models"]): ForecastEvaluationReport => ({
  validationCutoff: "2026-09-20T00:00:00.000Z",
  models,
} as ForecastEvaluationReport);

assert.deepEqual(gradingStatus(undefined), { graded: false, gradableAt: null });
assert.deepEqual(
  gradingStatus(
    report([]),
  ),
  { graded: false, gradableAt: "2026-09-20T00:00:00.000Z" },
  "before any grade, the frozen validation boundary is shown",
);
const graded = gradingStatus(
  report([
    { family: "curve", version: "curve:v1", training: {} as never, validation: { count: 10, soldShare: 0.25, expectedShare: 0.3, brier: 0.2, calibrationError: 0.05 }, reservedCount: 0 },
    { family: "buyer-choice", version: "choice:v1", training: {} as never, validation: { count: 8, soldShare: 0.25, expectedShare: 0.3, brier: 0.15, calibrationError: 0.05 }, reservedCount: 0 },
  ]),
);
assert.ok(graded.graded);
assert.equal(graded.label, "buyer-choice (choice:v1)", "the lowest Brier score leads");
assert.ok(Math.abs(graded.baseRate - 0.1875) < 1e-12);

console.log("PASS strategy verdict ranks hurdles and reads the grading status");
