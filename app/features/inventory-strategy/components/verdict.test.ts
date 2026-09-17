import assert from "node:assert/strict";
import type { InventoryStrategyHurdleScenario } from "../types/inventoryStrategy";
import { hurdleReturns, STRATEGY_COST_BASIS } from "./verdict";

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

assert.deepEqual(
  STRATEGY_COST_BASIS,
  { costBasisShareOfMarket: 0.75, costBasisDiscountPerUnit: 0.3 },
  "the strategy cost basis follows the estimated purchase cost rule",
);

console.log("PASS strategy verdict ranks hurdles by cycle return");
