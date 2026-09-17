import assert from "node:assert/strict";
import { recordEstimatedPurchaseCosts } from "./estimatedPurchaseCosts.server";

const recorded: Array<{ requestId: string; totalAmountCents: number; batchNumbers: number[] }> = [];
const run = await recordEstimatedPurchaseCosts("seller-a", {}, {
  findUncostedBatchReceipts: async () => [
    { batchNumber: 3, receipts: [
      { receiptId: 1, originalQuantity: 2, marketValue: 2, intakeAt: "2026-08-01T00:00:00Z" },
      { receiptId: 2, originalQuantity: 1, marketValue: 0.1, intakeAt: null },
    ] },
    { batchNumber: 4, receipts: [{ receiptId: 3, originalQuantity: 1, marketValue: null, intakeAt: null }] },
    { batchNumber: 5, receipts: [{ receiptId: 4, originalQuantity: 1, marketValue: 8, intakeAt: null }] },
  ],
  recordPurchaseCost: async (input) => {
    recorded.push({ requestId: input.requestId, totalAmountCents: input.totalAmountCents, batchNumbers: input.batchNumbers });
    return { entryId: `entry-${input.batchNumbers[0]}`, repeated: input.batchNumbers[0] === 5 };
  },
});

assert.deepEqual(run.recorded, [{ batchNumber: 3, entryId: "entry-3", totalAmountCents: 240, unitCount: 3 }]);
assert.deepEqual(run.repeated, [5]);
assert.deepEqual(run.marketUnavailable, [{ batchNumber: 4, receiptIds: [3] }]);
assert.deepEqual(recorded.map((entry) => entry.requestId), [
  "estimated-purchase-cost:market-rate-v1:batch-3",
  "estimated-purchase-cost:market-rate-v1:batch-5",
]);
console.log("PASS estimated purchase costs are recorded once per uncosted batch");