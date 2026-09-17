import assert from "node:assert/strict";
import {
  ESTIMATED_PURCHASE_COST_RULE,
  estimateBatchPurchaseCost,
  estimateUnitCostCents,
} from "./estimatedPurchaseCost";

assert.equal(ESTIMATED_PURCHASE_COST_RULE.marketRate, 0.75);
assert.equal(estimateUnitCostCents(10), 720, "75% of $10.00 less $0.30 is $7.20");
assert.equal(estimateUnitCostCents(0.4), 0, "75% of $0.40 is exactly the deduction");
assert.equal(estimateUnitCostCents(0.39), -1, "a unit below the deduction carries a negative cost");
assert.equal(estimateUnitCostCents(1.234), 62, "market is rounded to cents before the share");
assert.equal(estimateUnitCostCents(0), -30, "a worthless unit costs minus the full deduction");
assert.throws(() => estimateUnitCostCents(-1), /nonnegative/);

const estimated = estimateBatchPurchaseCost("seller-a", 12, [
  { receiptId: 5, originalQuantity: 3, marketValue: 10, intakeAt: "2026-08-11T03:00:00Z" },
  { receiptId: 7, originalQuantity: 1, marketValue: 0.2, intakeAt: "2026-08-10T23:30:00Z" },
]);
assert.equal(estimated.status, "estimated");
if (estimated.status === "estimated") {
  assert.deepEqual(estimated.estimate.purchaseCost, {
    requestId: "estimated-purchase-cost:market-rate-v2:batch-12",
    sellerKey: "seller-a",
    purchaseReference: "estimated:batch-12",
    currency: "USD",
    totalAmountCents: 2145,
    provenance: "estimated",
    source: "intake",
    allocationRule: "explicit",
    batchNumbers: [12],
    purchasedAt: "2026-08-10",
    explicitAllocations: [
      { receiptId: 5, amountCents: 2160 },
      { receiptId: 7, amountCents: -15 },
    ],
  });
  assert.equal(estimated.estimate.unitCount, 4);
}

const undated = estimateBatchPurchaseCost("seller-a", 13, [
  { receiptId: 9, originalQuantity: 2, marketValue: 4, intakeAt: null },
]);
assert.equal(undated.status, "estimated");
if (undated.status === "estimated") {
  assert.equal("purchasedAt" in undated.estimate.purchaseCost, false, "unknown intake dates stay unknown");
}

assert.deepEqual(
  estimateBatchPurchaseCost("seller-a", 14, [
    { receiptId: 1, originalQuantity: 1, marketValue: 5, intakeAt: null },
    { receiptId: 2, originalQuantity: 1, marketValue: null, intakeAt: null },
  ]),
  { status: "market_unavailable", batchNumber: 14, receiptIds: [2] },
  "a batch with any unquoted lot is not estimated",
);
assert.throws(() => estimateBatchPurchaseCost("seller-a", 15, []), /at least one receipt/);

console.log("PASS estimated purchase cost rule");