import assert from "node:assert/strict";
import {
  BatchCostRateUnavailableError,
  changeBatchEstimatedCostRate,
  recordEstimatedPurchaseCosts,
  recordMissingEstimatedPurchaseCosts,
} from "./estimatedPurchaseCosts.server";

const recorded: Array<{ requestId: string; totalAmountCents: number; batchNumbers: number[]; correctsEntryId?: string; correctionReason?: string }> = [];
const lot = (receiptId: number, originalQuantity: number, marketValue: number | null, allocatedAmountCents: number | null = null) =>
  ({ receiptId, originalQuantity, marketValue, intakeAt: receiptId === 1 ? "2026-08-01T00:00:00Z" : null, allocatedAmountCents });
const run = await recordEstimatedPurchaseCosts("seller-a", {}, {
  findEstimableBatchReceipts: async () => [
    { batchNumber: 3, currentEstimate: null, costRate: null, receipts: [lot(1, 2, 2), lot(2, 1, 0.1)] },
    { batchNumber: 4, currentEstimate: null, costRate: null, receipts: [lot(3, 1, null)] },
    { batchNumber: 5, currentEstimate: null, costRate: null, receipts: [lot(4, 1, 8)] },
    { batchNumber: 6, currentEstimate: { entryId: "6-v1", requestId: "estimated-purchase-cost:market-rate-v1:batch-6" }, costRate: null,
      receipts: [lot(5, 1, 8, 570), lot(6, 2, 0.2, 0)] },
    { batchNumber: 7, currentEstimate: { entryId: "7-v1", requestId: "estimated-purchase-cost:market-rate-v1:batch-7" }, costRate: null,
      receipts: [lot(7, 1, 8, 570)] },
    { batchNumber: 8, currentEstimate: { entryId: "8-v2", requestId: "estimated-purchase-cost:market-rate-v2:batch-8" }, costRate: null,
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
  { requestId: "estimated-purchase-cost:market-rate-v2:batch-6:corrects-6-v1", totalAmountCents: 540, batchNumbers: [6],
    correctsEntryId: "6-v1", correctionReason: "Re-estimated under rule market-rate-v2" },
]);
console.log("PASS estimated purchase costs are recorded once per batch and corrected when the rule changes them");

const atRate: Array<{ requestId: string; totalAmountCents: number }> = [];
const rateRun = await recordEstimatedPurchaseCosts("seller-a", { batchNumbers: [9, 10] }, {
  findEstimableBatchReceipts: async () => [
    { batchNumber: 9, currentEstimate: null, costRate: { marketRate: 0.6, perUnitDeductionCents: 50 }, receipts: [lot(9, 2, 10)] },
    { batchNumber: 10, currentEstimate: { entryId: "10-v2", requestId: "estimated-purchase-cost:market-rate-v2:batch-10:market-0.6-less-50c" },
      costRate: { marketRate: 0.6, perUnitDeductionCents: 50 }, receipts: [lot(10, 1, 10, 550)] },
  ],
  recordPurchaseCost: async (input) => {
    atRate.push({ requestId: input.requestId, totalAmountCents: input.totalAmountCents });
    return { entryId: `entry-${input.batchNumbers[0]}`, repeated: false };
  },
});
assert.deepEqual(atRate, [
  { requestId: "estimated-purchase-cost:market-rate-v2:batch-9:market-0.6-less-50c", totalAmountCents: 1100 },
], "a batch with its own rate is estimated at that rate, including when its market arrives after intake");
assert.deepEqual(rateRun.repeated, [10], "a batch already estimated at its rate is not re-estimated at the default");
console.log("PASS a batch's own cost rate survives later estimate sweeps");

const sixty = { marketRate: 0.6, perUnitDeductionCents: 50 };
const fifty = { marketRate: 0.5, perUnitDeductionCents: 0 };
const sixtyId = "estimated-purchase-cost:market-rate-v2:batch-11:market-0.6-less-50c";
let savedRate: { batchNumber: number; rate: unknown } | null = null;
const changes: Array<{ requestId: string; totalAmountCents: number; correctsEntryId?: string; correctionReason?: string }> = [];
const rateChange = (current: { entryId: string; requestId: string } | null, estimable = true) => ({
  transaction: async <T>(work: (executor: never) => Promise<T>) => work({} as never),
  findEstimableBatchReceipts: async () => estimable ? [{ batchNumber: 11, currentEstimate: current,
    costRate: savedRate?.rate as typeof sixty ?? sixty, receipts: [lot(11, 2, 10, current ? 550 : null)] }] : [],
  saveBatchEstimatedCostRate: async (batchNumber: number, rate: typeof sixty) => { savedRate = { batchNumber, rate }; },
  recordPurchaseCost: async (input: { requestId: string; totalAmountCents: number; correctsEntryId?: string; correctionReason?: string }) => {
    changes.push({ requestId: input.requestId, totalAmountCents: input.totalAmountCents,
      ...(input.correctsEntryId ? { correctsEntryId: input.correctsEntryId, correctionReason: input.correctionReason } : {}) });
    return { entryId: `entry-${changes.length}`, repeated: false };
  },
}) as never;

const lowered = await changeBatchEstimatedCostRate("seller-a", 11, fifty, rateChange({ entryId: "11-a", requestId: sixtyId }));
assert.deepEqual(savedRate, { batchNumber: 11, rate: fifty });
assert.deepEqual(lowered.recorded.map((entry) => entry.correctsEntryId), ["11-a"]);
const loweredId = "estimated-purchase-cost:market-rate-v2:batch-11:market-0.5-less-0c:corrects-11-a";
assert.deepEqual(changes, [{ requestId: loweredId, totalAmountCents: 1000, correctsEntryId: "11-a",
  correctionReason: "Re-estimated under rule market-rate-v2 at 50% of market less $0.00 per card" }],
  "a changed rate corrects the batch's current estimate");
savedRate = null;
await changeBatchEstimatedCostRate("seller-a", 11, sixty, rateChange({ entryId: "11-b", requestId: loweredId }));
assert.equal(changes[1].requestId, `${sixtyId}:corrects-11-b`,
  "returning to an earlier rate records a new correction instead of reusing that rate's request ID");
const again = await changeBatchEstimatedCostRate("seller-a", 11, sixty, rateChange({ entryId: "11-c", requestId: changes[1].requestId }));
assert.deepEqual(again.repeated, [11], "a correction already at the batch's rate is not corrected again");
savedRate = null;
await assert.rejects(changeBatchEstimatedCostRate("seller-a", 11, fifty, rateChange(null, false)), BatchCostRateUnavailableError);
assert.equal(savedRate, null, "a batch with an entered purchase cost keeps it and saves no rate");
console.log("PASS changing a batch's cost rate corrects its estimate and can return to an earlier rate");

const swept: Array<{ sellerKey: string; batchNumbers?: number[] }> = [];
const sweep = (uncosted: number[]) => recordMissingEstimatedPurchaseCosts("seller-a", {
  findUncostedBatchNumbers: async () => uncosted,
  recordEstimatedPurchaseCosts: async (sellerKey, options = {}) => {
    swept.push({ sellerKey, ...(options.batchNumbers ? { batchNumbers: options.batchNumbers } : {}) });
    return { ...run, recorded: [] };
  },
});
assert.equal(await sweep([]), null, "nothing is estimated when every batch is costed");
assert.deepEqual(swept, []);
assert.ok(await sweep([2733, 3536]));
assert.deepEqual(swept, [{ sellerKey: "seller-a", batchNumbers: [2733, 3536] }],
  "only batches with an uncosted lot are estimated, never the whole ledger");
console.log("PASS missing estimated purchase costs are retried for uncosted batches only");
