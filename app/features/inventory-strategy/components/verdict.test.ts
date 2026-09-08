import assert from "node:assert/strict";
import type { InventoryStrategyHurdleScenario } from "../types/inventoryStrategy";
import type { ForecastEvaluationReport } from "~/features/pricing/domain/forecastEvaluation";
import { forecastGradingOverview, hurdleReturns } from "./verdict";

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

const report = (
  models: ForecastEvaluationReport["models"],
  pairedComparisons: ForecastEvaluationReport["pairedComparisons"] = [],
): ForecastEvaluationReport => ({
  validationCutoff: "2026-09-20T00:00:00.000Z",
  policy: { minimumPairedValidationCount: 20 } as ForecastEvaluationReport["policy"],
  models,
  pairedComparisons,
} as ForecastEvaluationReport);

assert.deepEqual(forecastGradingOverview(undefined), {
  state: "unavailable", label: "Forecast validation has insufficient evidence",
});
assert.match(forecastGradingOverview(report([])).label, /Forecast validation reserved through/);

const curve = { family: "curve" as const, version: "curve:v1", training: {} as never,
  validation: { count: 100, soldShare: 0.5, expectedShare: 0.5, brier: 0.2, calibrationError: 0 }, reservedCount: 0 };
assert.deepEqual(forecastGradingOverview(report([curve])), {
  state: "scored", label: "1 forecast version scored · no cross-model pair is available",
});

const buyer = { family: "buyer-choice" as const, version: "buyer:v1", training: {} as never,
  validation: { count: 30, soldShare: 0.5, expectedShare: 0.5, brier: 0.3, calibrationError: 0 }, reservedCount: 0 };
const condition = { family: "condition-rate" as const, version: "condition:v1", training: {} as never,
  validation: { count: 20, soldShare: 0.5, expectedShare: 0.5, brier: 0.01, calibrationError: 0 }, reservedCount: 0 };
assert.equal(
  forecastGradingOverview(report([curve, buyer], [
    { left: curve.version, right: buyer.version, validationCount: 1, leftBrier: 0.4, rightBrier: 0.1 },
  ])).label,
  "2 forecast versions scored · 0 of 1 pair comparison meets the 20-observation minimum",
  "a sparse pair is reported without selecting a model",
);
assert.equal(
  forecastGradingOverview(report([curve, buyer], [
    { left: curve.version, right: buyer.version, validationCount: 20, leftBrier: 0.2, rightBrier: 0.15 },
  ])).label,
  "2 forecast versions scored · 1 of 1 pair comparison meets the 20-observation minimum",
);
assert.equal(
  forecastGradingOverview(report([curve, buyer, condition], [
    { left: curve.version, right: buyer.version, validationCount: 30, leftBrier: 0.2, rightBrier: 0.3 },
    { left: curve.version, right: condition.version, validationCount: 20, leftBrier: 0.4, rightBrier: 0.01 },
    { left: buyer.version, right: condition.version, validationCount: 20, leftBrier: 0.4, rightBrier: 0.01 },
  ])).label,
  "3 forecast versions scored · 3 of 3 pair comparisons meet the 20-observation minimum",
  "three compatible pairs produce a neutral overview rather than a global winner",
);

console.log("PASS strategy verdict ranks hurdles and summarizes forecast comparisons neutrally");
