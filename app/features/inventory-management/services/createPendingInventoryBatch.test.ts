import assert from "node:assert/strict";
import type { InventoryBatch } from "~/features/pending-inventory/types/inventoryBatch";
import {
  createPendingInventoryBatch,
  PendingBatchRequestError,
} from "./createPendingInventoryBatch";

const batches = new Map<string, InventoryBatch>();
const receivedRequestIds: string[] = [];
let createdCount = 0;
let responseDropped = true;

const batch = await createPendingInventoryBatch("batch-request-1", async (_url, init) => {
  const requestId = JSON.parse(String(init.body)).requestId as string;
  receivedRequestIds.push(requestId);
  let saved = batches.get(requestId);
  if (!saved) {
    createdCount += 1;
    saved = { batchNumber: 71 } as InventoryBatch;
    batches.set(requestId, saved);
  }
  if (responseDropped) {
    responseDropped = false;
    throw new Error("connection closed after commit");
  }
  return {
    ok: true,
    status: 201,
    json: async () => saved,
  };
});

assert.equal(batch.batchNumber, 71);
assert.equal(createdCount, 1);
assert.deepEqual(receivedRequestIds, ["batch-request-1", "batch-request-1"]);

let serverErrorCount = 0;
const serverErrorRequestIds: string[] = [];
const recovered = await createPendingInventoryBatch("batch-request-2", async (_url, init) => {
  serverErrorRequestIds.push(JSON.parse(String(init.body)).requestId);
  serverErrorCount += 1;
  return serverErrorCount === 1
    ? { ok: false, status: 500, json: async () => ({ error: "response failed" }) }
    : { ok: true, status: 201, json: async () => ({ batchNumber: 72 }) };
});
assert.equal(recovered.batchNumber, 72);
assert.equal(serverErrorCount, 2);
assert.deepEqual(serverErrorRequestIds, ["batch-request-2", "batch-request-2"]);

for (const status of [408, 500]) {
  let attempts = 0;
  await assert.rejects(
    createPendingInventoryBatch(`batch-request-${status}`, async () => {
      attempts += 1;
      return {
        ok: false,
        status,
        json: async () => ({ error: "response failed" }),
      };
    }),
    (error: unknown) =>
      error instanceof PendingBatchRequestError && error.outcome === "uncertain",
  );
  assert.equal(attempts, 2);
}

console.log("PASS uncertain batch responses retry one durable request and remain recoverable");
