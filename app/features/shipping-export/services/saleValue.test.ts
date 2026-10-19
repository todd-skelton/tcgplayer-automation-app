import assert from "node:assert/strict";
import type { ShippingIntakeLineHistory, TcgPlayerShippingOrder } from "../types/shippingExport";
import { saleValueOfOrders, saleValuesBySku } from "./saleValue";

function history(skuId: string, overrides: Partial<ShippingIntakeLineHistory> = {}): ShippingIntakeLineHistory {
  return {
    skuId,
    status: "current",
    allocationRevisionId: "r1",
    allocatedSourceOrderRevision: 1,
    currentSourceOrderRevision: 1,
    orderTime: "2026-10-01T00:00:00.000Z",
    orderedQuantity: 2,
    soldTotal: 6,
    matchedQuantity: 2,
    unmatchedQuantity: 0,
    priceKnownQuantity: 2,
    dateKnownQuantity: 2,
    recordedPriceQuantity: 2,
    estimatedPriceQuantity: 0,
    intakeMarketTotal: 5,
    weightedDaysHeld: 10,
    minimumDaysHeld: 10,
    maximumDaysHeld: 10,
    lots: [],
    ...overrides,
  };
}

function order(orderNumber: string, lines = [history("1")]): TcgPlayerShippingOrder {
  return {
    "Order #": orderNumber,
    FirstName: "Ash",
    LastName: "Ketchum",
    Address1: "1 Pokemon Way",
    Address2: "",
    City: "Pallet",
    State: "CA",
    PostalCode: "90001",
    Country: "US",
    "Order Date": "2026-10-01",
    "Product Weight": 0,
    "Shipping Method": "Standard",
    "Item Count": 3,
    "Value Of Products": 16,
    "Shipping Fee Paid": 0,
    "Tracking #": "",
    Carrier: "",
    products: [
      { name: "Abra", quantity: 2, unitPrice: 3, marketPrice: 4, skuId: 1 },
      { name: "Zubat", quantity: 1, unitPrice: 10, skuId: 2 },
    ],
    intakeHistory: { orderNumber, sellerKey: "seller", lines, refreshedAt: "2026-10-01T00:00:00.000Z" },
  };
}

const batch = saleValueOfOrders([order("A"), order("A")]);
assert.equal(batch.price, 16, "a repeated order is counted once");
assert.deepEqual(batch.market, { total: 8, difference: -2, percent: -25, partial: "1 of 2 lines priced" });
assert.deepEqual(batch.intake, {
  total: 5,
  difference: 1,
  percent: 20,
  partial: "2 of 3 units have an intake price",
});
assert.equal(batch.ageDays, 10);
assert.equal(batch.agePartial, "2 of 3 units have an intake date");

const cards = saleValuesBySku([order("A"), order("B")]);
assert.deepEqual(cards.get(1), {
  price: 12,
  market: { total: 16, difference: -4, percent: -25, partial: null },
  intake: { total: 10, difference: 2, percent: 20, partial: null },
  ageDays: 10,
  agePartial: null,
}, "a card sums its SKU across orders and covers all of its own units");
assert.deepEqual(cards.get(2), { price: 20, market: null, intake: null, ageDays: null, agePartial: null });

const unrecorded = saleValueOfOrders([order("C", [history("1", { status: "pending" })])]);
assert.equal(unrecorded.intake, null, "lines whose history is not current carry no intake comparison");

console.log("PASS sale value measures cards, orders, and batches against market and intake with the same math");
