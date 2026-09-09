import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { capitalCycle } from "~/features/pricing/domain/capitalCycle";
import { TurnaroundInputs } from "../components/TurnaroundInputs";
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
  unsupportedPurchaseFunding: [],
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

const currentExcess = structuredClone(report);
currentExcess.unsupportedPurchaseFunding = [{kind:"above_current_cost",adjustmentReference:"excess",
  purchaseReference:"purchase-1",currency:"USD",amountCents:2_000,effectiveAt:"2026-09-01",sourceIdentity:"excess"}];
const excessSelection=selectTurnaround(sellerKey,null,observed,currentExcess,null,now);
assert.equal(excessSelection.effectiveSource,"manual-fallback");
assert.equal(excessSelection.effectiveDays,28);
assert.deepEqual(excessSelection.evidence?.unsupportedPurchaseFunding,[{currency:"USD",amountCents:2_000}]);
assert.match(excessSelection.fallbackReasons.join(" "),/purchase funding remains unsupported/i);

const futureExcess = structuredClone(currentExcess);
futureExcess.unsupportedPurchaseFunding[0].effectiveAt="2026-09-09";
assert.equal(selectTurnaround(sellerKey,null,observed,futureExcess,null,now).effectiveSource,"observed-seller");
const currentEurOrphan=structuredClone(report);
currentEurOrphan.unsupportedPurchaseFunding=[{kind:"orphan",adjustmentReference:"orphan",purchaseReference:"missing",
  currency:"EUR",amountCents:2_000,effectiveAt:"2026-09-01",sourceIdentity:"orphan"}];
const eurSelection=selectTurnaround(sellerKey,null,observed,currentEurOrphan,null,now);
assert.equal(eurSelection.effectiveSource,"manual-fallback");
assert.deepEqual(eurSelection.evidence?.unsupportedPurchaseFunding,[{currency:"EUR",amountCents:2_000}]);
assert.match(eurSelection.fallbackReasons.join(" "),/currencies are never mixed/i);
const futureEurOrphan=structuredClone(currentEurOrphan);
futureEurOrphan.unsupportedPurchaseFunding[0].effectiveAt="2026-09-09";
assert.equal(selectTurnaround(sellerKey,null,observed,futureEurOrphan,null,now).effectiveSource,"observed-seller");
const zeroEurOrphan=structuredClone(currentEurOrphan);
zeroEurOrphan.unsupportedPurchaseFunding[0].amountCents=0;
assert.equal(selectTurnaround(sellerKey,null,observed,zeroEurOrphan,null,now).effectiveSource,"observed-seller");

const missingFundingMetadata=structuredClone(report) as unknown as Record<string,unknown>;
delete missingFundingMetadata.unsupportedPurchaseFunding;
assert.equal(selectTurnaround(sellerKey,null,observed,missingFundingMetadata as unknown as ReinvestmentTurnaroundReport,null,now).effectiveSource,"manual-fallback");
const malformedFundingMetadata=structuredClone(report) as unknown as Record<string,unknown>;
malformedFundingMetadata.unsupportedPurchaseFunding=[{currency:"USD",amountCents:"2000",effectiveAt:"2026-09-01"}];
assert.equal(selectTurnaround(sellerKey,null,observed,malformedFundingMetadata as unknown as ReinvestmentTurnaroundReport,null,now).effectiveSource,"manual-fallback");
const invalidCurrencyMetadata=structuredClone(report) as unknown as Record<string,unknown>;
invalidCurrencyMetadata.unsupportedPurchaseFunding=[{kind:"orphan",adjustmentReference:"invalid",purchaseReference:null,
  currency:"INVALID",amountCents:2_000,effectiveAt:"2026-09-01",sourceIdentity:"invalid"}];
const invalidCurrencySelection=selectTurnaround(sellerKey,null,observed,invalidCurrencyMetadata as unknown as ReinvestmentTurnaroundReport,null,now);
assert.equal(invalidCurrencySelection.effectiveSource,"manual-fallback");
const invalidCurrencyHtml=renderToStaticMarkup(createElement(TurnaroundInputs,{selection:invalidCurrencySelection,
  productLine:"All product lines",busy:false,onSave:()=>undefined}));
assert.doesNotMatch(invalidCurrencyHtml,/INVALID/);
const undatedFundingMetadata=structuredClone(report);
undatedFundingMetadata.unsupportedPurchaseFunding=[{kind:"orphan",adjustmentReference:"undated",purchaseReference:null,
  currency:"USD",amountCents:2_000,effectiveAt:"",sourceIdentity:"undated"}];
assert.equal(selectTurnaround(sellerKey,null,observed,undatedFundingMetadata,null,now).effectiveSource,"manual-fallback");
const oldReport=structuredClone(report) as ReinvestmentTurnaroundReport;
Object.assign(oldReport,{ruleVersion:"pooled-proceeds/v1"});
assert.equal(selectTurnaround(sellerKey,null,observed,oldReport,null,now).effectiveSource,"manual-fallback");

const poorLine = structuredClone(report);
poorLine.samples = poorLine.samples.slice(0, 2).map((value) => ({ ...value, proceedsProvenance: "estimated" }));
assert.equal(selectTurnaround(sellerKey, lineId, observed, poorLine, null, now).effectiveSource, "manual-fallback");
assert.match(selectTurnaround(sellerKey, lineId, observed, poorLine, null, now).fallbackReasons.join(" "), /less than 80%/i);

assert.equal(selectTurnaround(sellerKey, null, observed, report, "rebuild failed", now).effectiveSource, "manual-fallback");
assert.equal(selectTurnaround("another-seller", null, [{ ...observed[0], sellerKey: "another-seller" }], report, null, now).effectiveSource, "manual-fallback");
console.log("PASS observed turnaround selects only complete, fresh, seller-scoped evidence with explicit fallback");
