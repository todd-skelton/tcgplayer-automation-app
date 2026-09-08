import assert from "node:assert/strict";
import { compareOrdersToIntake, intakeDeltaAmount, intakeDeltaPercent } from "./orderIntakeComparison";
import type { ShippingIntakeLineHistory, TcgPlayerShippingOrder } from "../types/shippingExport";

function history(overrides: Partial<ShippingIntakeLineHistory> = {}): ShippingIntakeLineHistory {
  return {
    skuId: "9001", status: "current", allocationRevisionId: "1", allocatedSourceOrderRevision: 1,
    currentSourceOrderRevision: 1, orderTime: "2026-08-01T12:00:00.000Z", orderedQuantity: 3,
    matchedQuantity: 3, unmatchedQuantity: 0, priceKnownQuantity: 2, dateKnownQuantity: 1,
    recordedPriceQuantity: 1, estimatedPriceQuantity: 1, intakeMarketTotal: 8,
    weightedDaysHeld: 40, minimumDaysHeld: 40, maximumDaysHeld: 40, lots: [], ...overrides,
  };
}

function order(line = history()): TcgPlayerShippingOrder {
  return {
    "Order #": "A", FirstName: "", LastName: "", Address1: "", Address2: "", City: "", State: "",
    PostalCode: "", Country: "US", "Order Date": line.orderTime, "Product Weight": 0,
    "Shipping Method": "Standard", "Item Count": 3, "Value Of Products": 20, "Shipping Fee Paid": 0,
    "Tracking #": "", Carrier: "", products: [
      { name: "same SKU lower sale", quantity: 2, unitPrice: 5, skuId: 9001, inventorySkuId: "9001" },
      { name: "same SKU higher sale", quantity: 1, unitPrice: 10, skuId: 9001, inventorySkuId: "9001" },
    ], intakeHistory: { orderNumber: "A", refreshedAt: "2026-08-01T12:01:00.000Z", lines: [line] },
  };
}

const repeated = order();
const comparison = compareOrdersToIntake([repeated, repeated]);
assert.equal(comparison.soldTotal, 20);
assert.equal(comparison.comparableSoldTotal, 40 / 3);
assert.equal(comparison.intakeMarketTotal, 8);
assert.equal(comparison.orderedQuantity, 3);
assert.equal(comparison.priceKnownQuantity, 2);
assert.equal(comparison.dateKnownQuantity, 1);
assert.equal(comparison.estimatedPriceQuantity, 1);
assert.ok(Math.abs((intakeDeltaAmount(comparison) ?? 0) - 16 / 3) < 1e-12);
assert.equal(comparison.weightedDaysHeld, 40);

const knownZero = compareOrdersToIntake([order(history({ orderedQuantity: 1, matchedQuantity: 1,
  priceKnownQuantity: 1, dateKnownQuantity: 0, recordedPriceQuantity: 1, estimatedPriceQuantity: 0,
  intakeMarketTotal: 0, weightedDaysHeld: null, minimumDaysHeld: null, maximumDaysHeld: null }))]);
assert.equal(intakeDeltaAmount(knownZero), 20 / 3);
assert.equal(intakeDeltaPercent(knownZero), null);

const held = compareOrdersToIntake([order(history({ status: "held" }))]);
assert.equal(held.priceKnownQuantity, 0);
assert.equal(held.heldLineCount, 1);
assert.equal(intakeDeltaAmount(held), null);

console.log("PASS intake comparison de-duplicates orders and preserves SKU-weighted sale, price, date, and zero-value coverage");
