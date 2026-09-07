import assert from "node:assert/strict";
import type { InventoryBatch } from "~/features/pending-inventory/types/inventoryBatch";
import { createPendingInventoryBatch } from "./createPendingInventoryBatch";

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

console.log("PASS a dropped batch response retries one durable request exactly once");
