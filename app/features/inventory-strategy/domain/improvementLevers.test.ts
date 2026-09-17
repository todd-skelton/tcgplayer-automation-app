import assert from "node:assert/strict";
import { improvementLevers } from "./improvementLevers";
import type { PerformanceSummary } from "./realizedPerformance";
import type { InventoryStrategyHurdleScenario } from "../types/inventoryStrategy";

const scenario = (dailyReturnHurdle: number, physicalValue: number, medianDays: number, configured = false): InventoryStrategyHurdleScenario => ({
  dailyReturnHurdle, configured, oneCopyValue: physicalValue, physicalValue, modeledSkuCount: 1,
  raisedCount: 0, loweredCount: 0, heldCount: 0,
  estimatedTime: { medianDays, p75Days: medianDays * 2, p90Days: medianDays * 3 },
});
const summary = (overrides: Partial<PerformanceSummary>): PerformanceSummary => ({
  productLine: "All", unitsSold: 50, includedUnits: 50, proceedsCents: 100_000, costCents: 75_000, profitCents: 25_000,
  marginPercent: 25, markupPercent: 33, profitPerDayCents: 800, dailyReturnPercent: 1.2, averageDaysHeld: 12, ...overrides,
});

const levers = improvementLevers({
  configuredHurdle: 0.005,
  best: { scenario: scenario(0.015, 19_000, 6), dailyReturn: 0.0058 },
  configured: { scenario: scenario(0.005, 20_100, 21, true), dailyReturn: 0.0051 },
  overall: summary({}),
  productLines: [
    summary({ productLine: "Pokemon", dailyReturnPercent: 1.4, costCents: 60_000 }),
    summary({ productLine: "YuGiOh", dailyReturnPercent: 0.2, costCents: 5_000, averageDaysHeld: 40 }),
    summary({ productLine: "Sparse", dailyReturnPercent: 0.1, includedUnits: 3 }),
  ],
  waitingCents: 12_345,
  oldestWaitingDays: 9,
  modeledUnits: 800,
  totalUnits: 1000,
});
assert.deepEqual(levers.map((lever) => lever.title), [
  "Raise the hurdle to 1.50%/day",
  "Sales are clearing the hurdle",
  "Below the hurdle: YuGiOh",
  "Well above the hurdle: Pokemon",
  "$123.45 of proceeds not yet republished",
  "200 listed units have no forecast",
]);
assert.match(levers[0].detail, /Models 0\.58%\/day on capital against 0\.51%\/day now · -\$1,100\.00 listed value · -15\.0 days median wait/);
assert.match(levers[1].detail, /Realized 1\.20%\/day on capital against a 0\.50%\/day hurdle/);
assert.match(levers[2].detail, /YuGiOh returned 0\.20%\/day on \$50\.00 of cost, held 40 days/);
assert.match(levers[4].detail, /oldest has waited 9 days/);

const quiet = improvementLevers({
  configuredHurdle: 0.005,
  best: { scenario: scenario(0.005, 20_100, 21, true), dailyReturn: 0.0051 },
  configured: { scenario: scenario(0.005, 20_100, 21, true), dailyReturn: 0.0051 },
  overall: summary({ dailyReturnPercent: 0.3 }),
  productLines: [],
  waitingCents: 0,
  oldestWaitingDays: null,
  modeledUnits: 950,
  totalUnits: 1000,
});
assert.deepEqual(quiet.map((lever) => lever.title), ["Sales are returning less than the hurdle assumes"]);

assert.deepEqual(improvementLevers({
  configuredHurdle: 0.005, best: undefined, configured: undefined, overall: null, productLines: [],
  waitingCents: 0, oldestWaitingDays: null, modeledUnits: 0, totalUnits: 0,
}), []);
console.log("PASS improvement levers name the hurdle, realized return, product lines, idle cash, and coverage");
