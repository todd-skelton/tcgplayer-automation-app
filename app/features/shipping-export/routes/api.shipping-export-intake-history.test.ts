import assert from "node:assert/strict";
import { createShippingIntakeHistoryAction } from "./api.shipping-export-intake-history.server";
import { DEFAULT_SHIPPING_EXPORT_CONFIG } from "../types/shippingExport";

const configured = async () => ({ ...DEFAULT_SHIPPING_EXPORT_CONFIG, defaultSellerKey: "seller-a" });
const request = (body: unknown) => new Request("http://localhost/api/shipping-export/intake-history", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const order = { orderNumber: "A", orderDate: "2026-08-01T12:00:00.000Z", itemCount: 1,
  products: [{ inventorySkuId: "9001", skuId: 9001, quantity: 1 }] };

let called = false;
const mismatched = await createShippingIntakeHistoryAction({ getConfig: configured, enrich: async () => {
  called = true; return [];
} })({ request: request({ sellerKey: "seller-b", orders: [order] }) });
assert.equal(mismatched.init?.status, 403);
assert.equal(called, false);

const success = await createShippingIntakeHistoryAction({ getConfig: configured, enrich: async (orders, sellerKey) => {
  assert.equal(sellerKey, "seller-a");
  assert.equal(orders[0]?.FirstName, "");
  return orders.map((value) => ({ ...value, intakeHistory: { orderNumber: value["Order #"], refreshedAt: "now", lines: [] } }));
} })({ request: request({ sellerKey: "seller-a", orders: [order] }) });
assert.equal(success.init?.status ?? 200, 200);
assert.deepEqual(success.data, { histories: [{ orderNumber: "A", refreshedAt: "now", lines: [] }] });

const oversized = await createShippingIntakeHistoryAction({ getConfig: configured, enrich: async () => [] })(
  { request: request({ sellerKey: "seller-a", orders: Array.from({ length: 501 }, () => order) }) },
);
assert.equal(oversized.init?.status, 400);

console.log("PASS shipping intake history route binds the configured seller and bounds local bulk refreshes");
