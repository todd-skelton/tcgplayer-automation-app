import assert from "node:assert/strict";
import type { ShippedOrder, SnapPublication, ShippingThresholdSnap } from "~/core/types/shippingThresholds";
import { shippingThresholdSnapOutcomes } from "./snapOutcomes";

const day = (value: number) => new Date(Date.UTC(2026, 9, value));
const snap = (outcome: ShippingThresholdSnap["outcome"]): ShippingThresholdSnap => ({
  threshold: 50, outcome, policyPrice: 51, snapPrice: 49.99,
  policyPriceShippingCost: 3.7, snapPriceShippingCost: 1.3,
  policyPriceReturn: 34, snapPriceReturn: 35, costModelLearnedAt: "2026-10-01T00:00:00.000Z",
});
const publication = (sku: number, published: number, outcome: ShippingThresholdSnap["outcome"]): SnapPublication => ({
  sku, publishedAt: day(published), listedPrice: outcome === "snapped" ? 49.99 : 51, snap: snap(outcome),
});
const order = (orderNumber: string, placed: number, itemValue: number, lines: ShippedOrder["lines"], postage = 5.8): ShippedOrder => ({
  orderNumber, orderTime: day(placed), itemValue, buyerShipping: 0, postage, lines,
});

const [outcome] = shippingThresholdSnapOutcomes({
  thresholds: [50],
  snapRange: 0.1,
  overheadRate: 0.15,
  publications: [
    publication(1, 1, "snapped"), publication(1, 2, "snapped"),
    publication(2, 1, "snapped"),
    publication(3, 1, "kept"),
    publication(4, 1, "snapped"), publication(4, 5, "kept"),
  ],
  orders: [
    // A buyer takes three snapped copies of SKU 1 and SKU 2 together.
    order("bulk", 4, 149.97 + 49.99, [{ sku: 1, quantity: 3, unitPrice: 49.99 }, { sku: 2, quantity: 1, unitPrice: 49.99 }]),
    // A lone snapped card ships first class.
    order("alone", 3, 49.99, [{ sku: 2, quantity: 1, unitPrice: 49.99 }], 0.85),
    // A kept card, and a sale before SKU 3 was ever considered.
    order("kept", 6, 51, [{ sku: 3, quantity: 1, unitPrice: 51 }]),
    order("before", 0, 52, [{ sku: 3, quantity: 1, unitPrice: 52 }]),
    // SKU 1 repriced away from the snap price is not a snapped sale.
    order("moved", 7, 30, [{ sku: 1, quantity: 1, unitPrice: 30 }], 0.85),
  ],
});

assert.deepEqual(outcome.listings, { snapped: 2, kept: 2, floor: 0 });
assert.equal(outcome.snapPrice, 49.99);
assert.equal(outcome.snapped.units, 5);
assert.equal(outcome.snapped.orders, 2);
assert.equal(outcome.snapped.largestOrderUnits, 4);
assert.equal(outcome.snapped.bulkOrderUnitShare, 0.8);
assert.equal(outcome.snapped.ordersReachingThreshold, 0.5);
assert.equal(outcome.snapped.ordersWithAddOns, 0);
assert.equal(outcome.snapped.medianDaysToSell, 3);
assert.equal(outcome.kept.units, 1);
assert.equal(outcome.kept.ordersReachingThreshold, undefined);
assert.equal(outcome.justAbove.units, 2);
assert.equal(outcome.justAbove.shippingCostPerOrder, 5.8);
console.log("PASS snap outcomes attribute sales to the decision in force and flag bulk buying and add-ons");
