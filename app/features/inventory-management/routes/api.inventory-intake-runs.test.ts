import assert from "node:assert/strict";
import { action } from "./api.inventory-intake-runs";

const payload = {
  requestId: "test-request",
  workflow: "publish",
  expectedInventory: [{ sku: 1, quantity: 2 }],
  expectedSellerKey: "seller",
};
async function status(
  body: unknown,
  headers: Record<string, string>,
  method = "POST",
) {
  const result = await action({
    request: new Request("http://localhost/api/inventory-intake-runs", {
      method,
      headers,
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
    }),
  });
  return result.init?.status;
}
assert.equal(await status(payload, { "content-type": "text/plain" }), 403);
assert.equal(
  await status(payload, {
    "content-type": "application/json",
    "sec-fetch-site": "cross-site",
  }),
  403,
);
assert.equal(await status(payload, {}, "GET"), 405);
const json = { "content-type": "application/json" };
for (const expectedInventory of [
  [],
  null,
  [{ sku: 1, quantity: 0 }],
  [
    { sku: 1, quantity: 1 },
    { sku: 1, quantity: 2 },
  ],
]) {
  assert.equal(await status({ ...payload, expectedInventory }, json), 400);
}
assert.equal(
  await status({ ...payload, expectedSellerKey: undefined }, json),
  400,
);
assert.equal(await status({ ...payload, purchaseCost: [] }, json), 400);
assert.equal(
  await status({ ...payload, padding: "x".repeat(256_001) }, json),
  413,
);
console.log(
  "PASS intake queue rejects cross-site/plain-text requests, missing or invalid snapshots, and oversized payloads before database work",
);
