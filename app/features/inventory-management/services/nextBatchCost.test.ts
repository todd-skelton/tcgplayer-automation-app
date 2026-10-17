import assert from "node:assert/strict";
import {
  DEFAULT_NEXT_BATCH_COST,
  describeNextBatchCost,
  describeQueuedCost,
  nextBatchCostAfterQueue,
  nextBatchCostProblem,
  nextBatchCostRequest,
} from "./nextBatchCost";

const atRate = { ...DEFAULT_NEXT_BATCH_COST, method: "cost_rate" as const, costRate: { marketPercent: "60", perCardDeduction: "0.50" } };
const purchase = {
  ...DEFAULT_NEXT_BATCH_COST,
  method: "purchase_total" as const,
  purchaseReference: " lot 7 ",
  purchaseTotal: " 45.00 ",
  purchaseDate: "2026-10-01",
  purchaseEstimated: true,
};

assert.match(describeNextBatchCost(DEFAULT_NEXT_BATCH_COST), /^Default estimate: \d+% of market less \$\d+\.\d\d per card$/);
assert.equal(describeNextBatchCost(atRate), "My rate: 60% of market less $0.50 per card");
assert.equal(describeNextBatchCost(purchase), "Purchase total: $45.00 (lot 7)");
assert.equal(describeNextBatchCost({ ...purchase, purchaseTotal: "$45.00" }), "Purchase total: $45.00 (lot 7)");
assert.equal(describeNextBatchCost({ ...purchase, purchaseTotal: " " }), "Purchase total: needs a reference and total");
assert.equal(describeNextBatchCost({ ...atRate, costRate: { marketPercent: "", perCardDeduction: "0" } }), "My rate: needs a valid rate");

assert.equal(nextBatchCostProblem(DEFAULT_NEXT_BATCH_COST), null);
assert.equal(nextBatchCostProblem(atRate), null);
assert.equal(nextBatchCostProblem(purchase), null);
assert.match(nextBatchCostProblem({ ...atRate, costRate: { marketPercent: "abc", perCardDeduction: "0" } }) ?? "", /valid cost rate/);
assert.match(nextBatchCostProblem({ ...purchase, purchaseReference: "" }) ?? "", /purchase reference and total/);
assert.equal(nextBatchCostProblem({ ...DEFAULT_NEXT_BATCH_COST, costRate: { marketPercent: "abc", perCardDeduction: "" } }), null,
  "a bad rate only blocks queuing while the rate is chosen");

assert.deepEqual(nextBatchCostRequest(DEFAULT_NEXT_BATCH_COST), {});
assert.deepEqual(nextBatchCostRequest(atRate), { estimatedCostRate: { marketPercent: "60", perCardDeduction: "0.50" } });
assert.deepEqual(nextBatchCostRequest(purchase), {
  purchaseCost: {
    purchaseReference: "lot 7", totalAmount: "45.00", provenance: "estimated", allocationRule: "quantity",
    purchasedAt: "2026-10-01", currency: "USD",
  },
});
assert.equal(nextBatchCostRequest({ ...purchase, purchaseDate: "" }).purchaseCost?.purchasedAt, undefined);

assert.equal(describeQueuedCost(purchase), "the entered purchase total");
assert.equal(describeQueuedCost(atRate), "an estimate at 60% of market less $0.50 per card");
assert.match(describeQueuedCost(DEFAULT_NEXT_BATCH_COST), /^an estimate at the default /);

assert.deepEqual(nextBatchCostAfterQueue(atRate), atRate, "a lot's rate stays for its later batches");
assert.deepEqual(nextBatchCostAfterQueue(purchase), { ...DEFAULT_NEXT_BATCH_COST, purchaseEstimated: false },
  "a purchase total belongs to one handoff");

console.log("PASS next batch cost summarizes the choice, blocks incomplete entries, and keeps a lot's rate across handoffs");
