import assert from "node:assert/strict";
import {
  capitalCycle,
  capitalCycleAtHorizon,
  bestCapitalCycle,
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
  costBasisShareOfMarket: 0.725,
  costBasisDiscountPerUnit: 0,
  relativeOverhead: 0.15,
  staticOverheadPerUnit: 0.3,
  turnaroundDays: 28,
};
const range = { minimumHorizonDays: 0.1, maximumHorizonDays: 100_000 };
const cost = economics.costBasisShareOfMarket * portfolio.marketValue;

const cycle = capitalCycleAtHorizon(curve, portfolio, economics, 24);
assert.deepEqual(
  cycle,
  capitalCycle(horizonValue(curve, 24), 24, portfolio, economics),
  "a cycle at a horizon sells at the curve's value there",
);
assert.ok(
  Math.abs(
    cycle.netProceeds -
      (horizonValue(curve, 24) * (1 - economics.relativeOverhead) -
        economics.staticOverheadPerUnit * portfolio.unitCount),
  ) < 1e-9,
  "net proceeds take relative overhead off the sale and static overhead per unit",
);
assert.ok(Math.abs(cycle.profit - (cycle.netProceeds - cost)) < 1e-9);
assert.equal(cycle.cycleDays, 24 + economics.turnaroundDays);
assert.ok(Math.abs(cycle.profitPerDay - cycle.profit / cycle.cycleDays) < 1e-9);
assert.ok(cycle.dailyReturn !== undefined);
assert.ok(
  Math.abs(
    cycle.dailyReturn - Math.log(cycle.netProceeds / cost) / cycle.cycleDays,
  ) < 1e-12,
  "daily return is the continuous growth of the cost basis over the cycle",
);

const discounted = capitalCycleAtHorizon(
  curve,
  portfolio,
  { ...economics, costBasisDiscountPerUnit: 0.3 },
  24,
);
assert.ok(
  Math.abs(discounted.profit - (cycle.profit + 0.3 * portfolio.unitCount)) <
    1e-9,
  "the cost basis discount comes off per unit bought",
);
assert.equal(discounted.netProceeds, cycle.netProceeds);
const paidToTake = capitalCycleAtHorizon(
  curve,
  portfolio,
  { ...economics, costBasisDiscountPerUnit: 20 },
  24,
);
assert.ok(
  paidToTake.profit > paidToTake.netProceeds,
  "a discount beyond the share makes the cost basis negative",
);
assert.equal(
  paidToTake.dailyReturn,
  undefined,
  "no capital at risk means no rate of return",
);
assert.equal(
  capitalCycleAtHorizon(
    curve,
    portfolio,
    { ...economics, staticOverheadPerUnit: 100 },
    24,
  ).dailyReturn,
  undefined,
  "a cycle that brings nothing back has no rate of return",
);

const optimum = bestCapitalCycle(curve, portfolio, economics, range);
assert.ok(optimum !== undefined);
assert.ok(
  optimum.horizonDays > 12 && optimum.horizonDays < 20,
  `a four-week turnaround puts the best cycle in the mid teens, got ${optimum.horizonDays}`,
);
assert.deepEqual(
  optimum,
  capitalCycleAtHorizon(curve, portfolio, economics, optimum.horizonDays),
  "the best cycle is the cycle at its horizon",
);
const step = 1e-3;
const slope =
  (capitalCycleAtHorizon(
    curve,
    portfolio,
    economics,
    optimum.horizonDays + step,
  ).profitPerDay -
    capitalCycleAtHorizon(
      curve,
      portfolio,
      economics,
      optimum.horizonDays - step,
    ).profitPerDay) /
  (2 * step);
assert.ok(
  Math.abs(slope) < 1e-3,
  `profit per day is flat at the optimum, slope ${slope}`,
);

const fastTurnaround = bestCapitalCycle(
  curve,
  portfolio,
  { ...economics, turnaroundDays: 0 },
  range,
);
assert.ok(
  fastTurnaround !== undefined && fastTurnaround.horizonDays < 0.2,
  "with no turnaround and a deep discount the best cycle is the fastest sale",
);
assert.ok(
  (bestCapitalCycle(
    curve,
    portfolio,
    { ...economics, turnaroundDays: 90 },
    range,
  )?.horizonDays ?? 0) > optimum.horizonDays,
  "a longer turnaround pushes the best cycle out",
);
assert.equal(
  bestCapitalCycle(
    curve,
    portfolio,
    { ...economics, costBasisShareOfMarket: 1.5 },
    range,
  ),
  undefined,
  "no best cycle when every horizon loses money",
);

console.log("PASS capital cycle values a horizon by profit per day of cycle");
