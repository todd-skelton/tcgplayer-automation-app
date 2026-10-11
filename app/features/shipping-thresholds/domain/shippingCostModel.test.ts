import assert from "node:assert/strict";
import type { ShippedOrder } from "~/core/types/shippingThresholds";
import {
  MINIMUM_TIER_ORDERS,
  basketsNear,
  expectedShippingCost,
  learnShippingCostModel,
  orderShippingCost,
  tierForOrderValue,
} from "./shippingCostModel";

const order = (itemValue: number, buyerShipping: number, postage: number | undefined, unitPrices: number[]): ShippedOrder => ({
  orderNumber: `o-${itemValue}-${Math.random()}`,
  orderTime: new Date("2026-10-01T00:00:00Z"),
  itemValue,
  buyerShipping,
  ...(postage === undefined ? {} : { postage }),
  lines: unitPrices.map((unitPrice, index) => ({ sku: index + 1, quantity: 1, unitPrice })),
});

const repeat = <T>(count: number, make: () => T): T[] => Array.from({ length: count }, make);
const orders = [
  ...repeat(MINIMUM_TIER_ORDERS, () => order(3, 1.5, 0.7, [3])),
  ...repeat(MINIMUM_TIER_ORDERS, () => order(20, 0, 0.9, [20])),
  ...repeat(MINIMUM_TIER_ORDERS - 1, () => order(60, 0, 6, [60])),
  order(60, 0, undefined, [60]),
];
const model = learnShippingCostModel(orders, { learnedAt: "2026-10-11T00:00:00Z", evidenceWindowDays: 90 });

assert.deepEqual(model.tiers.map(({ fromOrderValue, buyerShipping, postage, basis }) =>
  ({ fromOrderValue, buyerShipping, postage, basis })), [
  { fromOrderValue: 0, buyerShipping: 1.5, postage: 0.7, basis: "observed" },
  { fromOrderValue: 5, buyerShipping: 0, postage: 0.9, basis: "observed" },
  { fromOrderValue: 50, buyerShipping: 0, postage: 5.77, basis: "default" },
  { fromOrderValue: 250, buyerShipping: 0, postage: 9.8, basis: "default" },
]);
assert.equal(model.tiers[2].orderCount, MINIMUM_TIER_ORDERS);
assert.equal(model.tiers[2].postageOrderCount, MINIMUM_TIER_ORDERS - 1);
console.log("PASS shipping tiers learn from recent orders and keep defaults where postage evidence is short");

assert.equal(tierForOrderValue(model.tiers, 4.99).fromOrderValue, 0);
assert.equal(tierForOrderValue(model.tiers, 49.99 + 0.01).fromOrderValue, 50);
assert.equal(orderShippingCost(model.tiers, 0, 0.15), 0);
assert.ok(Math.abs(orderShippingCost(model.tiers, 4.99, 0.1) - (0.7 - 1.5 * 0.9)) < 1e-9);
console.log("PASS order shipping cost reads the tier by whole cents and nets buyer shipping after fees");

const multiCopy = learnShippingCostModel([{ ...order(15, 0, 0.9, []), lines: [{ sku: 1, quantity: 3, unitPrice: 5 }] }],
  { learnedAt: "x", evidenceWindowDays: 30 });
assert.deepEqual(multiCopy.baskets, repeat(3, () => ({ unitPrice: 5, otherItemsValue: 10 })));
assert.equal(basketsNear(model, 50).length, MINIMUM_TIER_ORDERS);
assert.ok(basketsNear(model, 50).every((basket) => basket.unitPrice === 60));
assert.equal(basketsNear(model, 500).length, 0);
console.log("PASS each copy sold is a basket and only nearby prices describe a threshold's buyers");

const tiers = model.tiers;
const alone = [{ unitPrice: 50, otherItemsValue: 0 }];
const withOthers = [{ unitPrice: 50, otherItemsValue: 10 }];
assert.ok(Math.abs(expectedShippingCost(tiers, alone, 50.5, 0.15) - 5.77) < 1e-9);
assert.ok(Math.abs(expectedShippingCost(tiers, alone, 49.99, 0.15) - 0.9) < 1e-9);
assert.ok(Math.abs(expectedShippingCost(tiers, withOthers, 49.99, 0.15) - (5.77 - 0.9)) < 1e-9);
assert.ok(Math.abs(expectedShippingCost(tiers, withOthers, 50.5, 0.15) - (5.77 - 0.9)) < 1e-9);
console.log("PASS a unit's shipping cost is what it adds to the order it joins, so snapping helps only orders it keeps under");
