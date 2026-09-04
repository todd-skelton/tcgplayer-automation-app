import assert from "node:assert/strict";
import {
  forecastsWithinYear,
  resolveValueMatchedPortfolioPlan,
  readPricingDecision,
  readShadowPricingDecision,
  selectPricingDecision,
  toPricingCurve,
  type PricingCurvePoint,
} from "./pricingPolicy";

const normalizedCurve = toPricingCurve([
  {
    percentile: 50,
    suggestedPrice: 10,
    historicalSalesVelocityDays: 0,
    storeWinShare: 0.5,
    estimatedTimeToSellDays: 12,
  },
]);
assert.equal(normalizedCurve[0]?.buyerIntervalDays, undefined);
assert.equal(normalizedCurve[0]?.storeWinShare, 0.5);
assert.equal(
  normalizedCurve[0]?.estimatedMedianSellDays,
  12,
  "non-positive model inputs are dropped so the stored median is used",
);

const curve: PricingCurvePoint[] = [
  {
    percentile: 10,
    price: 5,
    estimatedMedianSellDays: 10,
    supplyStatus: "observed",
  },
  {
    percentile: 90,
    price: 15,
    estimatedMedianSellDays: 100,
    supplyStatus: "observed",
  },
];

const early = selectPricingDecision(curve, {
  method: "target-horizon",
  horizonDays: 20,
});
const late = selectPricingDecision(curve, {
  method: "target-horizon",
  horizonDays: 80,
});
assert.ok(early && late);
assert.ok(early.selectedPrice < late.selectedPrice);
assert.ok(early.equivalentPercentile! < late.equivalentPercentile!);
assert.ok(early.equivalentPercentile! >= 0);
assert.ok(late.equivalentPercentile! <= 100);

const identityCurve: PricingCurvePoint[] = [
  {
    percentile: 10,
    price: 5,
    buyerIntervalDays: 10 / Math.LN2,
    storeWinShare: 1,
    estimatedMedianSellDays: 10,
    supplyStatus: "observed",
  },
  {
    percentile: 90,
    price: 15,
    buyerIntervalDays: 50 / Math.LN2,
    storeWinShare: 0.5,
    estimatedMedianSellDays: 100,
    supplyStatus: "observed",
  },
];
for (const horizonDays of [10, 15, 20, 40, 80, 100]) {
  const identityDecision = selectPricingDecision(identityCurve, {
    method: "target-horizon",
    horizonDays,
  });
  assert.ok(identityDecision?.buyerIntervalDays);
  assert.ok(identityDecision?.storeWinShare);
  const identityMedian =
    (Math.LN2 * identityDecision.buyerIntervalDays) /
    identityDecision.storeWinShare;
  assert.ok(
    Math.abs(identityMedian - (identityDecision.estimatedMedianSellDays ?? 0)) <
      1e-10,
    "interpolated decisions preserve the median identity",
  );
  assert.ok(
    Math.abs(identityMedian - horizonDays) < 0.15,
    "the rounded selected price remains close to the requested horizon",
  );
}

const exactIdentityDecision = selectPricingDecision(identityCurve, {
  method: "target-horizon",
  horizonDays: 40,
});
assert.equal(
  exactIdentityDecision?.selectedPrice,
  10,
  "the closed-form inversion lands on the exact interpolated price",
);
assert.ok(
  Math.abs((exactIdentityDecision?.estimatedMedianSellDays ?? 0) - 40) < 1e-9,
  "the rational median inverts exactly to the requested horizon",
);
const exactLinearDecision = selectPricingDecision(curve, {
  method: "target-horizon",
  horizonDays: 55,
});
assert.equal(exactLinearDecision?.selectedPrice, 10);
assert.ok(
  Math.abs((exactLinearDecision?.estimatedMedianSellDays ?? 0) - 55) < 1e-9,
  "curves without buyer interval and win share invert linearly",
);
assert.equal(
  selectPricingDecision(identityCurve, {
    method: "target-horizon",
    horizonDays: 5,
  })?.selectedPrice,
  5,
  "horizons below the fastest point pin to that point",
);
assert.equal(
  selectPricingDecision(identityCurve, {
    method: "target-horizon",
    horizonDays: 500,
  })?.selectedPrice,
  15,
  "horizons above the slowest point pin to that point",
);

const profitPerDay = (
  dailyReturnHurdle: number,
  staticOverheadPerUnit = 0.3,
) => ({
  method: "profit-per-day" as const,
  dailyReturnHurdle,
  relativeOverhead: 0.15,
  staticOverheadPerUnit,
});
const patientReturn = selectPricingDecision(identityCurve, profitPerDay(0.001));
assert.equal(
  patientReturn?.selectedPrice,
  15,
  "a low hurdle waits for the slow, high point",
);
assert.equal(patientReturn?.dailyReturnHurdle, 0.001);
assert.equal(patientReturn?.basis, "modeled");
const hurriedReturn = selectPricingDecision(identityCurve, profitPerDay(0.05));
assert.equal(
  hurriedReturn?.selectedPrice,
  5,
  "a high hurdle takes the fast, low point",
);
const middlingReturn = selectPricingDecision(
  identityCurve,
  profitPerDay(0.012),
);
assert.ok(
  (middlingReturn?.selectedPrice ?? 0) > 5 &&
    (middlingReturn?.selectedPrice ?? 0) < 15,
  "a middling hurdle lands between the points",
);
const unprofitableReturn = selectPricingDecision(
  identityCurve,
  profitPerDay(0.005, 20),
  9,
);
assert.equal(
  unprofitableReturn?.selectedPrice,
  15,
  "overhead above every price lists at the slowest, highest point to limit the loss",
);
assert.equal(unprofitableReturn?.basis, "modeled");
assert.equal(unprofitableReturn?.unprofitable, true);
assert.equal(patientReturn?.unprofitable, undefined);
const slowLossCurve: PricingCurvePoint[] = [
  {
    percentile: 50,
    price: 15,
    estimatedMedianSellDays: 10,
    supplyStatus: "observed",
  },
  {
    percentile: 60,
    price: 14,
    estimatedMedianSellDays: 400,
    supplyStatus: "observed",
  },
];
assert.equal(
  selectPricingDecision(slowLossCurve, profitPerDay(0.005, 13))?.selectedPrice,
  15,
  "a loss is not discounted, so a slower, lower price cannot look better",
);

const constrainedIdentityDecision = selectPricingDecision(
  identityCurve,
  { method: "target-horizon", horizonDays: 20 },
  undefined,
  () => ({ price: 12.34, constraint: "floor" }),
);
assert.ok(constrainedIdentityDecision?.buyerIntervalDays);
assert.ok(constrainedIdentityDecision?.storeWinShare);
assert.ok(
  Math.abs(
    (Math.LN2 * constrainedIdentityDecision.buyerIntervalDays) /
      constrainedIdentityDecision.storeWinShare -
      (constrainedIdentityDecision.estimatedMedianSellDays ?? 0),
  ) < 1e-10,
  "constrained cent prices are projected back through the same model",
);

const resolved = resolveValueMatchedPortfolioPlan(
  [
    { sku: 1, currentPrice: 10, curve },
    {
      sku: 2,
      currentPrice: 20,
      curve: [
        {
          percentile: 10,
          price: 10,
          estimatedMedianSellDays: 10,
          supplyStatus: "observed",
        },
        {
          percentile: 90,
          price: 30,
          estimatedMedianSellDays: 100,
          supplyStatus: "observed",
        },
      ],
    },
    { sku: 3, currentPrice: 7, curve: [] },
  ],
  { createdAt: new Date("2026-08-31T12:00:00.000Z") },
);

assert.ok(Math.abs(resolved.plan.valueDifference) <= 0.02);
assert.equal(resolved.plan.baselineValue, 37);
assert.equal(resolved.plan.matchStatus, "matched");
assert.equal(resolved.decisionsBySku.get(3)?.constraint, "current-price");
assert.equal(resolved.plan.createdAt, "2026-08-31T12:00:00.000Z");

const legacyDecision = readPricingDecision({
  percentileUsed: 65,
  suggestedPrice: 12,
  marketplacePrice: 13,
  estimatedTimeToSellDays: 40,
});
assert.equal(legacyDecision?.method, "percentile");
assert.equal(legacyDecision?.selectedPrice, 13);
assert.equal(legacyDecision?.unconstrainedPrice, 12);
assert.equal(legacyDecision?.constraint, "floor");
assert.equal(legacyDecision?.basis, "legacy-unknown");
assert.equal(legacyDecision?.forecastStatus, "unavailable");

const legacyShadow = readShadowPricingDecision({
  pricingModelVersion: "unknown-model",
  shadowDecision: {
    method: "target-horizon",
    selectedPrice: 12,
    constraint: "none",
    basis: "modeled",
    forecastStatus: "interpolated",
  },
});
assert.equal(legacyShadow, undefined);

const currentShadow = readShadowPricingDecision({
  pricingModelVersion: "exposure-share-v1",
  shadowDecision: {
    method: "target-horizon",
    selectedPrice: 12,
    constraint: "none",
    basis: "modeled",
    forecastStatus: "interpolated",
  },
});
assert.equal(currentShadow?.basis, "modeled");

const constrained = selectPricingDecision(
  [
    {
      percentile: 5,
      price: 10,
      estimatedMedianSellDays: 10,
      supplyStatus: "observed",
    },
    {
      percentile: 95,
      price: 20,
      estimatedMedianSellDays: 100,
      supplyStatus: "observed",
    },
  ],
  { method: "target-horizon", horizonDays: 10 },
  10,
  () => ({ price: 20, constraint: "floor" }),
);
assert.equal(constrained?.selectedPrice, 20);
assert.equal(constrained?.unconstrainedPrice, 10);
assert.equal(constrained?.equivalentPercentile, 95);
assert.equal(constrained?.estimatedMedianSellDays, 100);

const aboveCurveConstraint = selectPricingDecision(
  [
    {
      percentile: 5,
      price: 10,
      estimatedMedianSellDays: 10,
      supplyStatus: "observed",
    },
    {
      percentile: 95,
      price: 20,
      estimatedMedianSellDays: 100,
      supplyStatus: "observed",
    },
  ],
  { method: "target-horizon", horizonDays: 10 },
  10,
  () => ({ price: 25, constraint: "floor" }),
);
assert.equal(aboveCurveConstraint?.selectedPrice, 25);
assert.equal(aboveCurveConstraint?.forecastStatus, "upper-bound");

const missingBaseline = resolveValueMatchedPortfolioPlan([
  { sku: 10, currentPrice: 10, curve },
  { sku: 11, curve },
]);
assert.equal(missingBaseline.plan.unavailableBaselineSkuCount, 1);
assert.equal(missingBaseline.decisionsBySku.has(11), false);
assert.ok(
  Math.abs(missingBaseline.plan.selectedOneCopyValue - 10) <=
    missingBaseline.plan.valueTolerance,
);

const identityTime = new Date("2026-08-31T12:00:00.000Z");
const changedCurvePlan = resolveValueMatchedPortfolioPlan(
  [
    {
      sku: 1,
      currentPrice: 10,
      curve: curve.map((point) => ({ ...point, price: point.price + 1 })),
    },
  ],
  { createdAt: identityTime },
);
const originalCurvePlan = resolveValueMatchedPortfolioPlan(
  [{ sku: 1, currentPrice: 10, curve }],
  { createdAt: identityTime },
);
assert.notEqual(changedCurvePlan.plan.id, originalCurvePlan.plan.id);

const boundaryPlan = resolveValueMatchedPortfolioPlan([
  {
    sku: 20,
    currentPrice: 10,
    curve: [
      {
        percentile: 5,
        price: 20,
        estimatedMedianSellDays: 10,
        supplyStatus: "observed",
      },
      {
        percentile: 95,
        price: 30,
        estimatedMedianSellDays: 100,
        supplyStatus: "observed",
      },
    ],
  },
]);
assert.equal(boundaryPlan.plan.matchStatus, "boundary");
assert.equal(boundaryPlan.plan.minimumReachableValue, 20);
assert.equal(boundaryPlan.plan.valueDifference, 10);

assert.throws(
  () =>
    resolveValueMatchedPortfolioPlan([
      { sku: 30, currentPrice: 10, curve },
      { sku: 30, currentPrice: 10, curve },
    ]),
  /one row per SKU.*30/,
);

const hopelessCurve = [
  {
    percentile: 5,
    price: 6,
    estimatedMedianSellDays: 400,
    supplyStatus: "observed" as const,
  },
  {
    percentile: 95,
    price: 25,
    estimatedMedianSellDays: 900,
    supplyStatus: "observed" as const,
  },
];
assert.equal(
  forecastsWithinYear(hopelessCurve),
  false,
  "a curve with no point within a year has no forecast to trade against",
);
assert.equal(forecastsWithinYear(curve), true);
assert.equal(
  forecastsWithinYear([{ ...hopelessCurve[0], estimatedMedianSellDays: 365 }]),
  true,
  "a year exactly still counts",
);
assert.equal(
  forecastsWithinYear([]),
  true,
  "a curve without observed sell times is judged by its supply status instead",
);

console.log(
  "PASS pricing policy interpolates continuously and value-matches one-copy inventory",
);
