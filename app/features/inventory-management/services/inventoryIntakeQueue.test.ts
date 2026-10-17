import assert from "node:assert/strict";
import { createPendingInventoryBatch } from "./createPendingInventoryBatch";
import { readPendingIntakeRequest } from "./pendingIntakeRequest";
import {
  describeIntakeRunSummary,
  intakeRunCost,
  intakeRunStatus,
  summarizeIntakeRuns,
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
const atRate = { ...request, purchaseCost: undefined, estimatedCostRate: { marketPercent: "60", perCardDeduction: "0.50" } };
assert.deepEqual(readPendingIntakeRequest({ getItem: () => JSON.stringify(atRate) }), JSON.parse(JSON.stringify(atRate)));
assert.throws(
  () => readPendingIntakeRequest({ getItem: () => JSON.stringify({ ...atRate, estimatedCostRate: { marketPercent: 60 } }) }),
  /invalid/,
  "a saved request with a malformed cost rate is not recovered",
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
  recordedCostCents: 1650,
  uncostedLotCount: 0,
  hasEnteredCost: false,
  costRate: null,
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
assert.equal(intakeRunCost(run), "Cost $16.50 estimated at the default 75% of market less $0.30 per card");
assert.equal(
  intakeRunCost({ ...run, costRate: { marketRate: 0.6, perUnitDeductionCents: 50 } }),
  "Cost $16.50 estimated at 60% of market less $0.50 per card",
);
assert.equal(intakeRunCost({ ...run, hasEnteredCost: true, recordedCostCents: 1200 }), "Cost $12.00 entered");
assert.match(intakeRunCost({ ...run, recordedCostCents: null, uncostedLotCount: 2 }), /^Cost not recorded yet; it will be estimated at the default/);
const settled = { ...run, pricingStatus: "completed" as const, planningStatus: "planned" as const };
assert.deepEqual(
  summarizeIntakeRuns([
    run,
    { ...run, pricingStatus: "pricing" },
    { ...run, pricingStatus: "failed" },
    { ...settled, publishedCount: 1, reviewCount: 1 },
    { ...settled, publishedCount: 2 },
    { ...settled, workflow: "price_only", planningStatus: "waiting" },
    { ...run, planningError: "Plan could not be built" },
  ]),
  { running: 3, needsAttention: 3 },
  "queued and pricing batches are running; failures, reviews, and errors need attention; settled batches are neither",
);
assert.equal(describeIntakeRunSummary({ running: 0, needsAttention: 0 }), "none running");
assert.equal(describeIntakeRunSummary({ running: 2, needsAttention: 1 }), "2 running, 1 needs review");
assert.equal(describeIntakeRunSummary({ running: 0, needsAttention: 2 }), "2 need review");
console.log(
  "PASS queued intake retains permission and cost through lost responses and displays distinct pricing/publication outcomes",
);
