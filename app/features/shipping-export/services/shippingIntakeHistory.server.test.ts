import assert from "node:assert/strict";
import { enrichShippingOrdersWithIntakeHistory } from "./shippingIntakeHistory.server";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";

const sale = new Date("2026-08-01T12:00:00.000Z");
function order(products?: TcgPlayerShippingOrder["products"]): TcgPlayerShippingOrder {
  return { "Order #": "A", FirstName: "", LastName: "", Address1: "", Address2: "", City: "", State: "",
    PostalCode: "", Country: "US", "Order Date": sale.toISOString(), "Product Weight": 0, "Shipping Method": "Standard",
    "Item Count": products?.reduce((sum, line) => sum + line.quantity, 0) ?? 3, "Value Of Products": 20,
    "Shipping Fee Paid": 0, "Tracking #": "", Carrier: "", products };
}

const allocations = async () => [{
  orderNumber: "A", currentOrderTime: sale, allocatedOrderTime: sale, currentSourceOrderRevision: 1,
  skuId: "9001", currentOrderedQuantity: 3, state: "allocated", holdReason: null,
  persistedSoldTotal: 20,
  allocatedOrderedQuantity: 3, matchedQuantity: 3, unmatchedQuantity: 0, priceKnownQuantity: 3,
  dateKnownQuantity: 3, intakeMarketTotal: 14, weightedDaysHeld: 130 / 3, revisionId: "10",
  allocatedSourceOrderRevision: 1, replayStatus: null, queueHoldReason: null, allocationPending: false,
  lots: [
    { supplyKey: "receipt:1", receiptId: 1, quantity: 2, availableAt: sale.toISOString(), dispositionId: null,
      quantityCorrectionId: null, receiptKind: "received", intakeAt: new Date(sale.getTime() - 60 * 86_400_000).toISOString(),
      marketValue: 4, marketProvenance: "tcgplayer_price_points", marketCalculatedAt: sale.toISOString() },
    { supplyKey: "receipt:2", receiptId: 2, quantity: 1, availableAt: sale.toISOString(), dispositionId: null,
      quantityCorrectionId: null, receiptKind: "received", intakeAt: new Date(sale.getTime() - 10 * 86_400_000).toISOString(),
      marketValue: 6, marketProvenance: "estimated_catalog_backfill", marketCalculatedAt: sale.toISOString() },
  ],
}];

const enriched = await enrichShippingOrdersWithIntakeHistory([order([
  { name: "first", quantity: 2, unitPrice: 5, inventorySkuId: "9001", skuId: 9001 },
  { name: "second", quantity: 1, unitPrice: 10, inventorySkuId: "9001", skuId: 9001 },
])], "seller", allocations as never);
const line = enriched[0]!.intakeHistory!.lines[0]!;
assert.equal(line.intakeMarketTotal, 14);
assert.ok(Math.abs((line.weightedDaysHeld ?? 0) - 43.3333333333) < 0.000001);
assert.deepEqual([line.minimumDaysHeld, line.maximumDaysHeld], [10, 60]);
assert.deepEqual([line.recordedPriceQuantity, line.estimatedPriceQuantity], [2, 1]);
assert.equal(line.lots[0]?.priceProvenance, "recorded");

const persistedOnly = await enrichShippingOrdersWithIntakeHistory([order()], "seller", allocations as never);
assert.deepEqual(persistedOnly[0]!.intakeHistory!.lines.map((value) => value.skuId), ["9001"]);

const unidentified = await enrichShippingOrdersWithIntakeHistory([order([
  { name: "known", quantity: 3, unitPrice: 5, inventorySkuId: "9001", skuId: 9001 },
  { name: "unknown", quantity: 1, unitPrice: 5 },
])], "seller", allocations as never);
assert.deepEqual(unidentified[0]!.intakeHistory!.lines.map((value) => [value.skuId, value.orderedQuantity, value.status]),
  [["9001", 3, "current"], ["unidentified", 1, "unavailable"]]);

console.log("PASS shipping intake enrichment uses one SKU aggregate, persisted-order fallback, explicit provenance, and unavailable identity coverage");
