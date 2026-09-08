import assert from "node:assert/strict";
import { refreshShippingIntakeHistory, withoutShippingIntakeHistory } from "./shippingIntakeHistory";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";

const source = [{
  "Order #": "A", FirstName: "Private", LastName: "Buyer", Address1: "Private address", Address2: "", City: "",
  State: "", PostalCode: "", Country: "US", "Order Date": "2026-08-01T12:00:00.000Z", "Product Weight": 0,
  "Shipping Method": "Standard", "Item Count": 1, "Value Of Products": 9, "Shipping Fee Paid": 0,
  "Tracking #": "", Carrier: "", products: [{ name: "Card", quantity: 1, unitPrice: 9, skuId: 9001, inventorySkuId: "9001" }],
  intakeHistory: { orderNumber: "A", sellerKey: "seller-a", refreshedAt: "stale", lines: [] },
}] satisfies TcgPlayerShippingOrder[];

let sent: any;
const refreshed = await refreshShippingIntakeHistory(source, "seller-a", async (_url, init) => {
  sent = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ histories: [{ orderNumber: "A", sellerKey: "seller-a", refreshedAt: "fresh", lines: [] }] }),
    { status: 200, headers: { "Content-Type": "application/json" } });
});
assert.equal(refreshed[0]?.intakeHistory?.refreshedAt, "fresh");
assert.deepEqual(sent, { sellerKey: "seller-a", orders: [{ orderNumber: "A", orderDate: "2026-08-01T12:00:00.000Z",
  itemCount: 1, products: [{ quantity: 1, skuId: 9001, inventorySkuId: "9001" }] }] });
assert.equal(JSON.stringify(sent).includes("Private"), false);
assert.equal(withoutShippingIntakeHistory(source)[0]?.intakeHistory, undefined);

console.log("PASS saved shipping history refresh sends only local identity evidence and can remove stale analytics");
