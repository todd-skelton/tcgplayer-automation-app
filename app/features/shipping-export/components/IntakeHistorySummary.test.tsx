import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { IntakeHistorySummary } from "./IntakeHistorySummary";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";

const order = {
  "Order #": "A", "Value Of Products": 10, "Item Count": 1,
  products: [{ name: "Card", quantity: 1, unitPrice: 10, skuId: 1, inventorySkuId: "1" }],
  intakeHistory: { orderNumber: "A", refreshedAt: "2026-08-01T12:00:00.000Z", lines: [{
    skuId: "1", status: "current", allocationRevisionId: "1", allocatedSourceOrderRevision: 1,
    currentSourceOrderRevision: 1, orderTime: "2026-08-01T12:00:00.000Z", orderedQuantity: 1,
    matchedQuantity: 1, unmatchedQuantity: 0, priceKnownQuantity: 1, dateKnownQuantity: 1,
    recordedPriceQuantity: 1, estimatedPriceQuantity: 0, intakeMarketTotal: 0, weightedDaysHeld: 10,
    minimumDaysHeld: 10, maximumDaysHeld: 10, lots: [{ supplyKey: "receipt:1", receiptId: 1, quantity: 1,
      availableAt: "2026-07-01T12:00:00.000Z", sourceKind: "received", intakeAt: "2026-07-22T12:00:00.000Z",
      daysHeld: 10, intakeMarketValue: 0, priceProvenance: "recorded" }],
  }] },
} as TcgPlayerShippingOrder;

const html = renderToStaticMarkup(<IntakeHistorySummary sourceOrders={[order]} label="Shipment" />);
assert.match(html, /Shipment intake market/);
assert.match(html, /\$0\.00/);
assert.match(html, /Sold vs intake market/);
assert.match(html, /Age at sale/);
assert.match(html, /<details/);
assert.match(html, /<summary/);
assert.match(html, /Receipt 1/);
assert.doesNotMatch(html, /profit/i);

console.log("PASS intake history summary labels zero-value coverage, fixed sale age, and keyboard-native lot disclosure");
