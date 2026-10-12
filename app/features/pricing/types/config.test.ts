import assert from "node:assert/strict";
import type { ShippingCostModel } from "~/core/types/shippingThresholds";
import {
  DEFAULT_PROFIT_PER_DAY_SETTINGS,
  DEFAULT_SERVER_PRICING_CONFIG,
  activePricingPolicy,
  normalizeServerPricingConfig,
  pricingCalculatorConfig,
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

assert.deepEqual(
  normalizeServerPricingConfig({}).pricing.shippingThresholdSnaps,
  { enabled: true, thresholds: [5, 50, 250], snapRange: 0.1, evidenceWindowDays: 90 },
);
assert.deepEqual(
  normalizeServerPricingConfig({
    pricing: { shippingThresholdSnaps: { enabled: false, thresholds: [50, 7, "5"], snapRange: 2, evidenceWindowDays: 45 } },
  }).pricing.shippingThresholdSnaps,
  { enabled: false, thresholds: [50], snapRange: 0.1, evidenceWindowDays: 90 },
  "unknown thresholds drop and invalid ranges or windows fall back",
);

const costModel: ShippingCostModel = {
  learnedAt: "2026-10-11T00:00:00.000Z", evidenceWindowDays: 90, orderCount: 0, tiers: [], baskets: [],
};
const profitConfig = {
  ...DEFAULT_SERVER_PRICING_CONFIG,
  pricing: { ...DEFAULT_SERVER_PRICING_CONFIG.pricing, policy: { method: "profit-per-day" as const } },
};
const snapping = pricingCalculatorConfig(profitConfig, { shippingCostModel: costModel }).policy;
assert.equal(snapping?.method === "profit-per-day" && snapping.shippingThresholdSnap?.costModel, costModel);
const withoutModel = pricingCalculatorConfig(profitConfig).policy;
assert.ok(withoutModel?.method === "profit-per-day" && !withoutModel.shippingThresholdSnap);
const legacyJobConfig = {
  ...profitConfig,
  pricing: { ...profitConfig.pricing, shippingThresholdSnaps: undefined as never },
};
const legacy = pricingCalculatorConfig(legacyJobConfig, { shippingCostModel: costModel }).policy;
assert.ok(legacy?.method === "profit-per-day" && legacy.shippingThresholdSnap,
  "a job queued before snaps existed reads the default snap settings instead of failing");
const off = pricingCalculatorConfig({
  ...profitConfig,
  pricing: { ...profitConfig.pricing, shippingThresholdSnaps: { ...profitConfig.pricing.shippingThresholdSnaps, enabled: false } },
}, { shippingCostModel: costModel }).policy;
assert.ok(off?.method === "profit-per-day" && !off.shippingThresholdSnap);
console.log("PASS shipping threshold snaps are configured safely and only attach with a learned model");

const retired = normalizeServerPricingConfig({
  pricing: { forecastCorrection: { enabled: true, evidenceWindowDays: 56 } },
}).pricing;
assert.ok(!("forecastCorrection" in retired),
  "a config saved while forecast corrections could apply reads without the retired setting");
console.log("PASS retired forecast correction settings are dropped from stored configs");

