import assert from "node:assert/strict";
import { calculateOrderEconomics, type OrderEconomicsEvidence } from "./orderEconomics";

const completeOrder: OrderEconomicsEvidence = {
  orderNumber: "SYNTHETIC-ORDER",
  currency: "USD",
  lifecycle: "completed_paid",
  orderedQuantity: 2,
  settledQuantity: 2,
  costKnownQuantity: 2,
  grossItemCents: 10_000,
  grossShippingCents: 500,
  grossOrderCents: 10_500,
  platformFeeCents: 1_000,
  providerNetCents: 9_500,
  directFeeCents: 0,
  refundEvidence: "none",
  postageCoverage: "actual",
  expenseEvidenceComplete: true,
  otherExpenses: [],
  acquisitionCostCents: 3_000,
  acquisitionCostCoverage: "actual",
};

const partialRefund = calculateOrderEconomics({
  ...completeOrder,
  orderNumber: "SYNTHETIC-ORDER-PARTIAL",
  refundGrossCents: 2_000,
  refundEvidence: "known",
  refundSettlement: {
    amountCents: 1_800,
    provenance: "actual",
    basis: "original_net_refund_adjustment",
  },
  postageCents: 500,
});
assert.equal(partialRefund.reusableCashCents, 7_200);
assert.equal(partialRefund.realizedProfitCents, 4_200);

const unknownRefund = calculateOrderEconomics({
  ...completeOrder,
  orderNumber: "SYNTHETIC-ORDER-UNKNOWN",
  refundGrossCents: 2_000,
  refundEvidence: "known",
  acquisitionCostCents: undefined,
  acquisitionCostCoverage: "unknown",
});
assert.equal(unknownRefund.reusableCashCents, undefined);
assert.match(unknownRefund.missing.join(" "), /refund settlement/);

const alreadyAdjusted = calculateOrderEconomics({
  ...completeOrder,
  orderNumber: "SYNTHETIC-ORDER-ADJUSTED",
  refundGrossCents: 2_000,
  refundEvidence: "known",
  refundSettlement: { amountCents: 7_700, provenance: "actual", basis: "already_adjusted_net" },
  postageCents: 500,
  acquisitionCostCents: undefined,
  acquisitionCostCoverage: "unknown",
});
assert.equal(alreadyAdjusted.reusableCashCents, 7_200);

const incompleteRefund = calculateOrderEconomics({
  ...completeOrder,
  orderNumber: "SYNTHETIC-ORDER-INCOMPLETE-REFUND",
  refundEvidence: "unknown",
});
assert.equal(incompleteRefund.reusableCashCents, undefined);
assert.equal(incompleteRefund.proceedsCoverage, "unknown");
assert.match(incompleteRefund.missing.join(" "), /complete refund amounts/);

const canceled = calculateOrderEconomics({
  ...completeOrder,
  orderNumber: "SYNTHETIC-ORDER-CANCELED",
  lifecycle: "canceled",
});
assert.equal(canceled.reusableCashCents, undefined);
assert.match(canceled.missing.join(" "), /final sale settlement/);

const partialCost = calculateOrderEconomics({
  ...completeOrder,
  orderNumber: "SYNTHETIC-ORDER-PARTIAL-COST",
  settledQuantity: 1,
  costKnownQuantity: 1,
  acquisitionCostCents: undefined,
  acquisitionCostCoverage: "unknown",
});
assert.equal(partialCost.realizedProfitCents, undefined);
assert.equal(partialCost.orderedQuantity, 2);
assert.equal(partialCost.settledQuantity, 1);
assert.equal(partialCost.costKnownQuantity, 1);

console.log("PASS reusable proceeds preserve source coverage and settled cost quantities");
