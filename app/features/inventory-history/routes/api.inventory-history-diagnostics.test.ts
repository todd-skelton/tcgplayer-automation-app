import assert from "node:assert/strict";
import { createInventoryHistoryDiagnosticsLoader } from "./api.inventory-history-diagnostics.server";

const diagnostic = { sellerKey: "seller-a", generatedAt: "2026-09-08T00:00:00Z" };
const loader = createInventoryHistoryDiagnosticsLoader({
  getConfig: async () => ({ defaultSellerKey: " seller-a " }) as never,
  getDiagnostics: async (sellerKey) => ({ ...diagnostic, sellerKey }) as never,
});
const response = await loader();
assert.equal(response.init?.status, undefined);
assert.deepEqual(response.data, { diagnostics: diagnostic });

const missing = await createInventoryHistoryDiagnosticsLoader({
  getConfig: async () => ({ defaultSellerKey: "" }) as never,
  getDiagnostics: async () => { throw new Error("should not run"); },
})();
assert.equal(missing.init?.status, 409);

console.log("PASS inventory history diagnostics are bound to the configured seller");
