import assert from "node:assert/strict";
import type { PricingCurvePoint, PricingPolicy } from "~/core/types/pricingPolicy";
import type { ShippingCostModel } from "~/core/types/shippingThresholds";
import { DEFAULT_SHIPPING_TIERS } from "~/features/shipping-thresholds/domain/shippingCostModel";
import { selectPricingDecision } from "./pricingPolicy";
import { thresholdToSnapUnder } from "./shippingThresholdSnap";

const point = (percentile: number, price: number, days: number): PricingCurvePoint => ({
  percentile, price, estimatedMedianSellDays: days, supplyStatus: "observed",
});
// The best return sits just above $50: cheaper barely sells faster, dearer waits far longer.
const curve = [point(10, 49, 10), point(50, 50.5, 10.1), point(90, 60, 200)];
const model = (otherItemsValue: number, count = 20): ShippingCostModel => ({
  learnedAt: "2026-10-11T00:00:00.000Z",
  evidenceWindowDays: 90,
  orderCount: count,
  tiers: [...DEFAULT_SHIPPING_TIERS],
  baskets: Array.from({ length: count }, () => ({ unitPrice: 50, otherItemsValue })),
});
const policy = (costModel?: ShippingCostModel): PricingPolicy => ({
  method: "profit-per-day",
  dailyReturnHurdle: 0.005,
  relativeOverhead: 0.15,
  staticOverheadPerUnit: 0,
  ...(costModel ? { shippingThresholdSnap: { thresholds: [5, 50, 250], snapRange: 0.1, costModel } } : {}),
});
const none = (price: number) => ({ price, constraint: "none" as const });

assert.equal(thresholdToSnapUnder(50, { thresholds: [5, 50, 250], snapRange: 0.1 }), 50);
assert.equal(thresholdToSnapUnder(55, { thresholds: [5, 50, 250], snapRange: 0.1 }), 50);
assert.equal(thresholdToSnapUnder(55.01, { thresholds: [5, 50, 250], snapRange: 0.1 }), undefined);
assert.equal(thresholdToSnapUnder(49.99, { thresholds: [5, 50, 250], snapRange: 0.1 }), undefined);
assert.equal(thresholdToSnapUnder(5.2, { thresholds: [50], snapRange: 0.1 }), undefined);
console.log("PASS only prices from a chosen threshold to the top of its snap range are considered");

const unsnapped = selectPricingDecision(curve, policy(), undefined, none)!;
assert.ok(unsnapped.selectedPrice >= 50 && unsnapped.selectedPrice <= 55);
assert.equal(unsnapped.shippingThresholdSnap, undefined);

const snapped = selectPricingDecision(curve, policy(model(0)), undefined, none)!;
assert.equal(snapped.selectedPrice, 49.99);
assert.equal(snapped.unconstrainedPrice, unsnapped.unconstrainedPrice);
assert.equal(snapped.shippingThresholdSnap?.outcome, "snapped");
assert.equal(snapped.shippingThresholdSnap?.policyPrice, unsnapped.selectedPrice);
assert.equal(snapped.shippingThresholdSnap?.snapPriceShippingCost, 0.83);
assert.equal(snapped.shippingThresholdSnap?.policyPriceShippingCost, 5.77);
assert.ok(snapped.estimatedMedianSellDays! < unsnapped.estimatedMedianSellDays!);
console.log("PASS a lone-card buyer's tracked postage makes listing at $49.99 return more, and the decision records it");

const kept = selectPricingDecision(curve, policy(model(100)), undefined, none)!;
assert.equal(kept.selectedPrice, unsnapped.selectedPrice);
assert.equal(kept.shippingThresholdSnap?.outcome, "kept");
assert.ok(kept.shippingThresholdSnap!.policyPriceReturn > kept.shippingThresholdSnap!.snapPriceReturn);
console.log("PASS when buyers' other items cross the threshold anyway the price is kept and the comparison recorded");

const floored = selectPricingDecision(curve, policy(model(0)), undefined, (price) =>
  price < 50.2 ? { price: 50.2, constraint: "floor" } : none(price))!;
assert.equal(floored.selectedPrice, unsnapped.selectedPrice);
assert.equal(floored.shippingThresholdSnap?.outcome, "floor");
console.log("PASS a snap never lists under the price floor");

const thin = selectPricingDecision(curve, policy(model(0, 19)), undefined, none)!;
assert.equal(thin.selectedPrice, unsnapped.selectedPrice);
assert.equal(thin.shippingThresholdSnap, undefined);
const unforecast = selectPricingDecision(
  curve.map((entry) => ({ ...entry, supplyStatus: "unavailable" as const })),
  policy(model(0)), undefined, none);
assert.equal(unforecast?.shippingThresholdSnap, undefined);
const percentile = selectPricingDecision(curve, { method: "percentile", percentile: 50 }, undefined, none)!;
assert.equal(percentile.shippingThresholdSnap, undefined);
console.log("PASS snaps need nearby sales, a forecast, and the profit-per-day policy");
