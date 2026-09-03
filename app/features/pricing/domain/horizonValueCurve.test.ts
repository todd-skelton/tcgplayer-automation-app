import assert from "node:assert/strict";
import {
  fitHorizonValueCurve,
  horizonGainElasticity,
  horizonHeadroomFraction,
  horizonKneeDays,
  horizonMarginalValuePerDay,
  horizonValue,
  logSpacedHorizons,
  type HorizonValueCurve,
} from "./horizonValueCurve";

const spaced = logSpacedHorizons(10, 33.5, 24);
assert.equal(spaced.length, 24);
assert.equal(spaced[0], 10, "the first horizon is exactly the minimum");
assert.equal(spaced.at(-1), 33.5, "the last horizon is exactly the maximum");
assert.ok(
  spaced.every((value, index) => index === 0 || value > spaced[index - 1]),
);

const known: HorizonValueCurve = {
  floorValue: 100,
  ceilingValue: 500,
  midpointDays: 30,
  steepness: 1.5,
  residual: 0,
};
const horizons = Array.from({ length: 25 }, (_, index) =>
  Math.exp(Math.log(0.5) + ((Math.log(2000) - Math.log(0.5)) * index) / 24),
);
const sampled = (value: (horizonDays: number) => number) =>
  horizons.map((horizonDays) => ({ horizonDays, value: value(horizonDays) }));

const fitted = fitHorizonValueCurve(
  sampled((horizonDays) => horizonValue(known, horizonDays)),
  known.floorValue,
  known.ceilingValue,
);
assert.ok(fitted);
assert.ok(
  Math.abs(fitted.midpointDays - known.midpointDays) < 1e-6,
  "the fit recovers the midpoint from exact samples",
);
assert.ok(
  Math.abs(fitted.steepness - known.steepness) < 1e-6,
  "the fit recovers the steepness from exact samples",
);
assert.ok(fitted.residual < 1e-9);

assert.equal(horizonValue(known, known.midpointDays), 300);
assert.ok(
  Math.abs(horizonHeadroomFraction(known, horizonKneeDays(known)) - 0.7887) <
    1e-3,
  "the knee sits where roughly 79% of headroom is captured",
);
assert.ok(
  Math.abs(horizonKneeDays(known) - 30 * (2 + Math.sqrt(3)) ** (1 / 1.5)) <
    1e-9,
);
assert.ok(
  Math.abs(horizonGainElasticity(known, known.midpointDays) - 0.75) < 1e-9,
  "elasticity at the midpoint is half the steepness",
);
const numericSlope =
  (horizonValue(known, 30.001) - horizonValue(known, 29.999)) / 0.002;
assert.ok(
  Math.abs(numericSlope - horizonMarginalValuePerDay(known, 30)) < 1e-4,
  "the marginal formula matches the numeric slope",
);

assert.equal(
  fitHorizonValueCurve([{ horizonDays: 1, value: 5 }], 5, 5),
  undefined,
  "no headroom means no curve",
);
assert.equal(
  fitHorizonValueCurve(
    [
      { horizonDays: 1, value: 100 },
      { horizonDays: 10, value: 300 },
      { horizonDays: 100, value: 500 },
    ],
    100,
    500,
  ),
  undefined,
  "saturated samples do not count toward the minimum interior samples",
);
assert.equal(
  fitHorizonValueCurve(
    sampled((horizonDays) => 600 - horizonValue(known, horizonDays)),
    100,
    500,
  ),
  undefined,
  "a falling curve has no positive steepness",
);

const fastMovers = {
  ...known,
  floorValue: 0,
  ceilingValue: 200,
  midpointDays: 3,
};
const slowMovers = {
  ...known,
  floorValue: 0,
  ceilingValue: 200,
  midpointDays: 300,
};
const twoClusters = fitHorizonValueCurve(
  sampled(
    (horizonDays) =>
      100 +
      horizonValue(fastMovers, horizonDays) +
      horizonValue(slowMovers, horizonDays),
  ),
  100,
  500,
);
assert.ok(twoClusters);
assert.ok(
  twoClusters.residual > 0.05,
  "fast and slow clusters far apart report a visibly worse fit",
);

console.log("PASS horizon value curve fits and evaluates in closed form");
