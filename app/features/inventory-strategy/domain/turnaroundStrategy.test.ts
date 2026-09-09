import assert from "node:assert/strict";
import { capitalCycle } from "~/features/pricing/domain/capitalCycle";
import { selectTurnaround } from "./turnaroundStrategy";
import type { ReinvestmentTurnaroundReport, ReinvestmentTurnaroundSample } from "../types/reinvestmentTurnaround";
import type { TurnaroundSetting } from "../types/turnaroundStrategy";

const now = new Date("2026-09-08T18:00:00.000Z");
const sellerKey = "synthetic-turnaround";
const lineId = 101;
const sample = (purchase: number, days: number, amountCents: number): ReinvestmentTurnaroundSample => {
  const soldAt = new Date(Date.UTC(2026, 7, 15 + purchase));
  return {
    sampleKey: `${purchase}-${days}`,
    currency: "USD",
    orderNumber: `order-${purchase}`,
    purchaseReference: `purchase-${purchase}`,
    receiptId: purchase * 10 + days,
    productLineId: lineId,
    amountCents,
    soldAt: soldAt.toISOString(),
    fundingAt: soldAt.toISOString(),
    publishedAt: new Date(soldAt.getTime() + days * 86_400_000).toISOString(),
    state: "completed",
    timingBasis: "known_funding",
    proceedsProvenance: "actual",
    costProvenance: "actual",
    fundingProvenance: "actual",
    turnaroundDays: days,
    explanation: "Synthetic pooled attribution.",
    sourceIdentities: [],
  };
};
const samples = Array.from({ length: 20 }, (_, index) => [
  sample(index, 10, 6_000),
  sample(index, 20, 4_000),
]).flat();
const report: ReinvestmentTurnaroundReport = {
  sellerKey,
  asOf: "2026-09-08T17:00:00.000Z",
  ruleVersion: "pooled-proceeds/v2",
  sourceFingerprint: "a".repeat(64),
  currentCorrectedView: true,
  datePrecision: "timestamp_sales_date_funding",
  currencies: [{
    currency: "USD", eligibleProceedsCents: 200_000, negativeProceedsCents: 0,
    completedCents: 200_000, waitingCents: 0, unallocatedProceedsCents: 0,
    reservedOrWithdrawnCents: 0, unsupportedFundingAdjustmentCents: 0,
    outsideFundingUsedCents: 0, outsideFundingSuppliedCents: 0,
    outsideDeficitSettlementCents: 0, outsideAvailableCents: 0,
    outsideReservedOrWithdrawnCents: 0, outstandingNegativeDeficitCents: 0,
    unresolvedPurchaseCostCents: 0, reinvestedPercent: 100, completionCoveragePercent: 100,
    completedDollarWeightedMeanDays: 14, completedWeightedMedianDays: 10,
    completedWeightedP90Days: 20, waitingDollarWeightedAgeDays: null, oldestWaitingDays: null,
    unallocatedDollarWeightedAgeDays: null, oldestUnallocatedDays: null,
  }],
  samples,
  excluded: [{ reason: "Orders without complete reusable-proceeds evidence", count: 1 }],
  coverage: {
    observedOrderCount: 21, eligibleOrderCount: 20, unknownProceedsOrderCount: 1,
    purchaseCount: 20, costedReceiptCount: 40, unknownCostReceiptCount: 0,
    unknownProceeds: [{ soldAt: "2026-05-01T00:00:00.000Z" }], unknownCosts: [],
  },
  orderCoverage: {
    runId: "run-1", source: "tcgplayer_api", status: "complete", searchRange: "LastThreeMonths",
    finishedAt: "2026-09-08T17:30:00.000Z", nextOffset: 20, expectedTotal: 20,
    ordersObserved: 20, detailsRecorded: 0, observedFrom: "2026-08-15T00:00:00.000Z",
    observedThrough: "2026-09-03T00:00:00.000Z", gaps: [],
  },
  convention: [],
};
const observed: TurnaroundSetting[] = [{
  sellerKey, productLineId: null, mode: "observed", manualTurnaroundDays: 28, updatedAt: now.toISOString(),
}];

const selected = selectTurnaround(sellerKey, null, observed, report, null, now);
assert.equal(selected.effectiveSource, "observed-seller");
assert.equal(selected.effectiveDays, 14);
assert.equal(selected.evidence?.slowerDays, 20);
assert.equal(capitalCycle(100, 20, { marketValue: 100, unitCount: 1 }, {
  costBasisShareOfMarket: 0.5, costBasisDiscountPerUnit: 0, relativeOverhead: 0,
  staticOverheadPerUnit: 0, turnaroundDays: selected.effectiveDays,
}).cycleDays, 34);

const sparse = selectTurnaround(sellerKey, 202, observed, report, null, now);
assert.equal(sparse.effectiveSource, "observed-seller");
assert.equal(sparse.evidence?.attribution, "seller-substituted-for-sparse-line");

const manual = selectTurnaround(sellerKey, null, [{ ...observed[0], mode: "manual" }], report, null, now);
assert.equal(manual.effectiveDays, 28);
assert.equal(capitalCycle(100, 20, { marketValue: 100, unitCount: 1 }, {
  costBasisShareOfMarket: 0.5, costBasisDiscountPerUnit: 0, relativeOverhead: 0,
  staticOverheadPerUnit: 0, turnaroundDays: manual.effectiveDays,
}).cycleDays, 48);

const recentUnknown = structuredClone(report);
recentUnknown.coverage.unknownProceeds.push({ soldAt: "2026-09-01T00:00:00.000Z" });
recentUnknown.coverage.unknownProceedsOrderCount += 1;
assert.equal(selectTurnaround(sellerKey, null, observed, recentUnknown, null, now).effectiveSource, "manual-fallback");

const waiting = structuredClone(report);
waiting.currencies[0].waitingCents = 1;
waiting.currencies[0].completionCoveragePercent = 99;
assert.match(selectTurnaround(sellerKey, null, observed, waiting, null, now).fallbackReasons.join(" "), /incomplete/i);

const poorLine = structuredClone(report);
poorLine.samples = poorLine.samples.slice(0, 2).map((value) => ({ ...value, proceedsProvenance: "estimated" }));
assert.equal(selectTurnaround(sellerKey, lineId, observed, poorLine, null, now).effectiveSource, "manual-fallback");
assert.match(selectTurnaround(sellerKey, lineId, observed, poorLine, null, now).fallbackReasons.join(" "), /less than 80%/i);

assert.equal(selectTurnaround(sellerKey, null, observed, report, "rebuild failed", now).effectiveSource, "manual-fallback");
assert.equal(selectTurnaround("another-seller", null, [{ ...observed[0], sellerKey: "another-seller" }], report, null, now).effectiveSource, "manual-fallback");
console.log("PASS observed turnaround selects only complete, fresh, seller-scoped evidence with explicit fallback");
