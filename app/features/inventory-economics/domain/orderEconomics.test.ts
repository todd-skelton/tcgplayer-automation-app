import assert from "node:assert/strict";
import { calculateOrderEconomics } from "./orderEconomics";

const partialRefund = calculateOrderEconomics({
  orderNumber: "SYNTHETIC-ORDER-PARTIAL",
  currency: "USD",
  grossItemCents: 10_000,
  grossShippingCents: 500,
  grossOrderCents: 10_500,
  platformFeeCents: 1_000,
  providerNetCents: 9_500,
  directFeeCents: 0,
  refundGrossCents: 2_000,
  refundSettlement: {
    amountCents: 1_800,
    provenance: "actual",
    basis: "original_net_refund_adjustment",
  },
  postageCents: 500,
  postageCoverage: "actual",
  otherExpenses: [],
  acquisitionCostCents: 3_000,
  acquisitionCostCoverage: "actual",
});
assert.equal(partialRefund.reusableCashCents, 7_200);
assert.equal(partialRefund.realizedProfitCents, 4_200);

const unknownRefund = calculateOrderEconomics({
  orderNumber: "SYNTHETIC-ORDER-UNKNOWN",
  currency: "USD",
  grossItemCents: 10_000,
  grossShippingCents: 500,
  grossOrderCents: 10_500,
  platformFeeCents: 1_000,
  providerNetCents: 9_500,
  refundGrossCents: 2_000,
  postageCoverage: "actual",
  otherExpenses: [],
  acquisitionCostCoverage: "unknown",
});
assert.equal(unknownRefund.reusableCashCents, undefined);
assert.match(unknownRefund.missing.join(" "), /refund settlement/);

const alreadyAdjusted = calculateOrderEconomics({
  orderNumber: "SYNTHETIC-ORDER-ADJUSTED",
  currency: "USD",
  grossItemCents: 10_000,
  grossShippingCents: 500,
  grossOrderCents: 10_500,
  platformFeeCents: 1_000,
  providerNetCents: 9_500,
  refundGrossCents: 2_000,
  refundSettlement: { amountCents: 7_700, provenance: "actual", basis: "already_adjusted_net" },
  postageCents: 500,
  postageCoverage: "actual",
  otherExpenses: [],
  acquisitionCostCoverage: "unknown",
});
assert.equal(alreadyAdjusted.reusableCashCents, 7_200);

console.log("PASS reusable proceeds preserve refund coverage and avoid double deductions");
