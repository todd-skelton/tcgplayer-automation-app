import assert from "node:assert/strict";
import { assumePostageCents, assumeRefundSettlement, refundEvidence } from "./strategyAssumptions";

assert.deepEqual(refundEvidence("", []), { status: "none" }, "the Seller Portal reports an empty status for unrefunded orders");
assert.deepEqual(refundEvidence("No Refund", []), { status: "none" });
assert.deepEqual(refundEvidence(null, null), { status: "unknown" }, "missing refund records stay unknown");
assert.deepEqual(refundEvidence("Partial Refund", [{ amount: 1.5 }, { amount: 2 }]), { status: "known", cents: 350 });
assert.deepEqual(refundEvidence("Partial Refund", [{ amount: "1.5" }]), { status: "unknown" });

assert.deepEqual(assumeRefundSettlement({ lifecycle: "canceled", refundGrossCents: 1000, grossOrderCents: 1000, providerNetCents: 870 }),
  { amountCents: 0, provenance: "estimated", basis: "already_adjusted_net" }, "a canceled order returns nothing");
assert.deepEqual(assumeRefundSettlement({ lifecycle: "completed_paid", refundGrossCents: 250, grossOrderCents: 1000, providerNetCents: 870 }),
  { amountCents: 218, provenance: "estimated", basis: "original_net_refund_adjustment" }, "a partial refund takes its gross share of net");
assert.deepEqual(assumeRefundSettlement({ lifecycle: "completed_paid", refundGrossCents: 250, grossOrderCents: null, providerNetCents: null }),
  { amountCents: 250, provenance: "estimated", basis: "original_net_refund_adjustment" });

assert.equal(assumePostageCents([]), 78, "default first-class rate when nothing was purchased");
assert.equal(assumePostageCents([120, 73, 78]), 78);
assert.equal(assumePostageCents([73, 78, 120, 400]), 99);

console.log("PASS strategy assumptions fill missing refund, settlement, and postage evidence");