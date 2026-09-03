import assert from "node:assert/strict";
import {
  DEFAULT_PROFIT_PER_DAY_SETTINGS,
  activePricingPolicy,
  normalizeServerPricingConfig,
  productLinePricingPolicy,
} from "./config";

assert.deepEqual(
  normalizeServerPricingConfig({
    pricing: { policy: { method: "target-horizon", horizonDays: 33.5 } },
  }).pricing.policy,
  { method: "target-horizon", horizonDays: 33.5 },
);
assert.deepEqual(
  normalizeServerPricingConfig({
    pricing: { policy: { method: "target-horizon", horizonDays: 0 } },
  }).pricing.policy,
  { method: "percentile" },
);

const profitPerDayConfig = normalizeServerPricingConfig({
  pricing: {
    policy: { method: "profit-per-day" },
    profitPerDay: {
      dailyReturnHurdle: 0,
      relativeOverhead: 1.5,
      staticOverheadPerUnit: 0,
    },
  },
});
assert.deepEqual(profitPerDayConfig.pricing.policy, {
  method: "profit-per-day",
});
assert.deepEqual(
  profitPerDayConfig.pricing.profitPerDay,
  {
    dailyReturnHurdle: 0.005,
    relativeOverhead: 0.15,
    staticOverheadPerUnit: 0,
  },
  "a zero hurdle and a whole-sale overhead fall back per field",
);
assert.deepEqual(activePricingPolicy(profitPerDayConfig.pricing), {
  method: "profit-per-day",
  dailyReturnHurdle: 0.005,
  relativeOverhead: 0.15,
  staticOverheadPerUnit: 0,
});

const productLineConfig = normalizeServerPricingConfig({
  productLinePricing: {
    defaultPercentile: 65,
    productLineSettings: {
      3: { percentile: 70, skip: false, dailyReturnHurdle: 0.02 },
      4: { percentile: 70, skip: false, dailyReturnHurdle: 0 },
    },
  },
});
assert.deepEqual(
  productLineConfig.productLinePricing.productLineSettings,
  {
    3: { percentile: 70, skip: false, dailyReturnHurdle: 0.02 },
    4: { percentile: 70, skip: false },
  },
  "a product line keeps only a valid hurdle override",
);
const profitPerDayPolicy = {
  method: "profit-per-day" as const,
  ...DEFAULT_PROFIT_PER_DAY_SETTINGS,
};
assert.deepEqual(
  productLinePricingPolicy(
    profitPerDayPolicy,
    productLineConfig.productLinePricing.productLineSettings[3],
  ),
  { ...profitPerDayPolicy, dailyReturnHurdle: 0.02 },
);
assert.equal(
  productLinePricingPolicy(
    profitPerDayPolicy,
    productLineConfig.productLinePricing.productLineSettings[4],
  ),
  profitPerDayPolicy,
  "a product line without an override keeps the policy as is",
);

console.log("PASS pricing policy configuration is normalized safely");
