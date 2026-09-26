import assert from "node:assert/strict";
import { createPendingInventoryBatch } from "./createPendingInventoryBatch";
import { readPendingIntakeRequest } from "./pendingIntakeRequest";
import {
  intakeRunStatus,
  type InventoryIntakeRun,
} from "../types/inventoryIntakeRun";

const request = {
  requestId: "recover-me",
  workflow: "publish" as const,
  expectedInventory: [{ sku: 1, quantity: 2 }],
  expectedSellerKey: "seller",
  purchaseCost: {
    purchaseReference: "lot",
    totalAmount: "4.50",
    allocationRule: "quantity" as const,
    provenance: "actual" as const,
    currency: "USD",
  },
};
assert.deepEqual(
  readPendingIntakeRequest({ getItem: () => JSON.stringify(request) }),
  request,
);
assert.equal(readPendingIntakeRequest({ getItem: () => null }), null);
assert.throws(
  () => readPendingIntakeRequest({ getItem: () => '{"workflow":"unknown"}' }),
  /invalid/,
);
let calls = 0;
await createPendingInventoryBatch(
  request.requestId,
  request.purchaseCost,
  async (url, init) => {
    assert.equal(url, "/api/inventory-intake-runs");
    assert.deepEqual(JSON.parse(String(init.body)), request);
    if (++calls === 1) throw new Error("lost response");
    return { ok: true, status: 201, json: async () => ({ batchNumber: 7 }) };
  },
  request.workflow,
  request,
);
assert.equal(calls, 2);
const run: InventoryIntakeRun = {
  batchNumber: 1,
  workflow: "publish",
  planningStatus: "waiting",
  planningError: null,
  pricingStatus: "queued",
  pricingError: null,
  itemCount: 2,
  quantity: 3,
  publishedCount: 0,
  publishingCount: 0,
  reviewCount: 0,
  createdAt: "",
};
assert.equal(intakeRunStatus(run), "Queued");
assert.equal(intakeRunStatus({ ...run, pricingStatus: "pricing" }), "Pricing");
assert.equal(
  intakeRunStatus({ ...run, pricingStatus: "failed" }),
  "Pricing failed",
);
assert.equal(
  intakeRunStatus({ ...run, pricingStatus: "completed" }),
  "Awaiting publication",
);
assert.equal(
  intakeRunStatus({
    ...run,
    pricingStatus: "completed",
    planningStatus: "planned",
    publishedCount: 2,
  }),
  "Published",
);
assert.equal(
  intakeRunStatus({
    ...run,
    pricingStatus: "completed",
    planningStatus: "planned",
    publishedCount: 1,
    reviewCount: 1,
  }),
  "Needs review",
);
assert.equal(
  intakeRunStatus({
    ...run,
    pricingStatus: "completed",
    workflow: "price_only",
  }),
  "Priced; review before publishing",
);
console.log(
  "PASS queued intake retains permission and cost through lost responses and displays distinct pricing/publication outcomes",
);
