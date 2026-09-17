import assert from "node:assert/strict";
import { recordEstimatedPurchaseCosts } from "./estimatedPurchaseCosts.server";

const recorded: Array<{ requestId: string; totalAmountCents: number; batchNumbers: number[]; correctsEntryId?: string; correctionReason?: string }> = [];
const lot = (receiptId: number, originalQuantity: number, marketValue: number | null, allocatedAmountCents: number | null = null) =>
  ({ receiptId, originalQuantity, marketValue, intakeAt: receiptId === 1 ? "2026-08-01T00:00:00Z" : null, allocatedAmountCents });
const run = await recordEstimatedPurchaseCosts("seller-a", {}, {
  findEstimableBatchReceipts: async () => [
    { batchNumber: 3, currentEstimate: null, receipts: [lot(1, 2, 2), lot(2, 1, 0.1)] },
    { batchNumber: 4, currentEstimate: null, receipts: [lot(3, 1, null)] },
    { batchNumber: 5, currentEstimate: null, receipts: [lot(4, 1, 8)] },
    { batchNumber: 6, currentEstimate: { entryId: "6-v1", requestId: "estimated-purchase-cost:market-rate-v1:batch-6" },
      receipts: [lot(5, 1, 8, 570), lot(6, 2, 0.2, 0)] },
    { batchNumber: 7, currentEstimate: { entryId: "7-v1", requestId: "estimated-purchase-cost:market-rate-v1:batch-7" },
      receipts: [lot(7, 1, 8, 570)] },
    { batchNumber: 8, currentEstimate: { entryId: "8-v2", requestId: "estimated-purchase-cost:market-rate-v2:batch-8" },
      receipts: [lot(8, 1, 8, 570)] },
  ],
  recordPurchaseCost: async (input) => {
    recorded.push({ requestId: input.requestId, totalAmountCents: input.totalAmountCents, batchNumbers: input.batchNumbers,
      ...(input.correctsEntryId ? { correctsEntryId: input.correctsEntryId, correctionReason: input.correctionReason } : {}) });
    return { entryId: `entry-${input.batchNumbers[0]}`, repeated: input.batchNumbers[0] === 5 };
  },
});

assert.deepEqual(run.recorded, [
  { batchNumber: 3, entryId: "entry-3", totalAmountCents: 218, unitCount: 3 },
  { batchNumber: 6, entryId: "entry-6", totalAmountCents: 540, unitCount: 3, correctsEntryId: "6-v1" },
]);
assert.deepEqual(run.repeated, [5, 8]);
assert.deepEqual(run.unchanged, [7]);
assert.deepEqual(run.marketUnavailable, [{ batchNumber: 4, receiptIds: [3] }]);
assert.deepEqual(recorded, [
  { requestId: "estimated-purchase-cost:market-rate-v2:batch-3", totalAmountCents: 218, batchNumbers: [3] },
  { requestId: "estimated-purchase-cost:market-rate-v2:batch-5", totalAmountCents: 570, batchNumbers: [5] },
  { requestId: "estimated-purchase-cost:market-rate-v2:batch-6", totalAmountCents: 540, batchNumbers: [6],
    correctsEntryId: "6-v1", correctionReason: "Re-estimated under rule market-rate-v2" },
]);
console.log("PASS estimated purchase costs are recorded once per batch and corrected when the rule changes them");