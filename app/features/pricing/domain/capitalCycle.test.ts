import assert from "node:assert/strict";
import {
  capitalCycleAtHorizon,
  bestCycleHorizonDays,
  type CapitalCycleEconomics,
} from "./capitalCycle";
import { horizonValue, type HorizonValueCurve } from "./horizonValueCurve";

const curve: HorizonValueCurve = {
  floorValue: 23_962,
  ceilingValue: 32_737,
  midpointDays: 20,
  steepness: 0.97,
  residual: 0.02,
};
const portfolio = { marketValue: 24_542, unitCount: 1_929 };
const economics: CapitalCycleEconomics = {
  costRatio: 0.725,
  relativeOverhead: 0.15,
  staticOverheadPerUnit: 0.3,
  turnaroundDays: 28,
};
const range = { minimumHorizonDays: 0.1, maximumHorizonDays: 100_000 };

const cycle = capitalCycleAtHorizon(curve, portfolio, economics, 24);
assert.ok(
  Math.abs(cycle.netProceeds - (horizonValue(curve, 24) * 0.85 - 0.3 * 1_929)) <
    1e-9,
  "net proceeds take relative overhead off the sale and static overhead per unit",
);
assert.ok(Math.abs(cycle.profit - (cycle.netProceeds - 0.725 * 24_542)) < 1e-9);
assert.equal(cycle.cycleDays, 52);
assert.ok(Math.abs(cycle.profitPerDay - cycle.profit / 52) < 1e-9);

const optimum = bestCycleHorizonDays(curve, portfolio, economics, range);
assert.ok(optimum !== undefined);
assert.ok(
  optimum > 12 && optimum < 20,
  `a four-week turnaround puts the best cycle in the mid teens, got ${optimum}`,
);
const step = 1e-3;
const slope =
  (capitalCycleAtHorizon(curve, portfolio, economics, optimum + step)
    .profitPerDay -
    capitalCycleAtHorizon(curve, portfolio, economics, optimum - step)
      .profitPerDay) /
  (2 * step);
assert.ok(
  Math.abs(slope) < 1e-3,
  `profit per day is flat at the optimum, slope ${slope}`,
);

const fastTurnaround = bestCycleHorizonDays(
  curve,
  portfolio,
  { ...economics, turnaroundDays: 0 },
  range,
);
assert.ok(
  fastTurnaround !== undefined && fastTurnaround < 0.2,
  "with no turnaround and a deep discount the best cycle is the fastest sale",
);
assert.ok(
  (bestCycleHorizonDays(
    curve,
    portfolio,
    { ...economics, turnaroundDays: 90 },
    range,
  ) ?? 0) > optimum,
  "a longer turnaround pushes the best cycle out",
);
assert.equal(
  bestCycleHorizonDays(
    curve,
    portfolio,
    { ...economics, costRatio: 1.5 },
    range,
  ),
  undefined,
  "no best cycle when every horizon loses money",
);

console.log("PASS capital cycle values a horizon by profit per day of cycle");
