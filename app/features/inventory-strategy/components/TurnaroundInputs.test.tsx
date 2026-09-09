import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnaroundInputs } from "./TurnaroundInputs";
import type { TurnaroundSelection } from "../types/turnaroundStrategy";

const selection: TurnaroundSelection = {
  setting: { sellerKey: "seller", productLineId: 7, mode: "observed", manualTurnaroundDays: 28, updatedAt: null },
  effectiveDays: 14,
  effectiveSource: "observed-seller",
  fallbackReasons: [],
  evidence: {
    scope: "seller", sourceProductLineId: null, attribution: "seller-substituted-for-sparse-line",
    reportAsOf: "2026-09-08T17:00:00.000Z", sourceFingerprint: "a".repeat(64),
    observationFrom: "2026-08-15T00:00:00.000Z", observationThrough: "2026-09-03T00:00:00.000Z",
    completedPurchaseCount: 20, completedCents: 200_000, waitingCents: 0, oldestWaitingDays: null,
    eligibleProceedsCents: 200_000, unallocatedProceedsCents: 0, oldestUnallocatedDays: null, unresolvedPurchaseCostCents: 0,
    unsupportedFundingAdjustmentCents: 0, reinvestedPercent: 100, completionCoveragePercent: 100,
    historicalUnknownProceedsCount: 1, historicalUnknownCostCount: 0,
    typicalDays: 14, slowerDays: 20, actualProceedsPercent: 100, actualCostPercent: 100,
    knownFundingPercent: 100, orderCoverageFinishedAt: "2026-09-08T17:30:00.000Z",
    orderObservedFrom: "2026-08-15T00:00:00.000Z", orderObservedThrough: "2026-09-03T00:00:00.000Z", confidence: "medium",
    limitations: ["Slower is a scenario, not a confidence bound."],
  },
};
const html = renderToStaticMarkup(<TurnaroundInputs selection={selection} productLine="Sparse line"
  busy={false} scenarioComparison={{horizonDays:20,effective:{cycleDays:34,profitPerDay:3},
    typical:{cycleDays:34,profitPerDay:3},slower:{cycleDays:40,profitPerDay:2.5}}} onSave={() => undefined} />);
assert.match(html, /Observed estimate/);
assert.match(html, /Manual fallback days/);
assert.match(html, /Effective 14\.0 days/);
assert.match(html, /Typical 14\.0 days/);
assert.match(html, /Slower p90 20\.0 days/);
assert.match(html, /20-day sell horizon \+ effective = 34\.0-day cycle/);
assert.match(html, /Slower = 40\.0-day cycle/);
assert.match(html, /Excluded historical unknowns outside the cohort: 1 proceeds/);
assert.match(html, /Seller-wide pooled timing is attributed to Sparse line because this line is sparse/);
assert.match(html, /not coverage boundaries/);

const fallback = renderToStaticMarkup(<TurnaroundInputs selection={{ ...selection, effectiveDays: 28,
  effectiveSource: "manual-fallback", fallbackReasons: ["Known proceeds remain waiting."],
  evidence: { ...selection.evidence!, waitingCents: 4_000 } }} productLine="Line" busy={false} onSave={() => undefined} />);
assert.match(fallback, /Manual fallback retained/);
assert.match(fallback, /Waiting \$40\.00/);
console.log("PASS turnaround controls render observed, substituted, and fallback evidence states");
