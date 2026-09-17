import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CapitalTurnaround } from "./CapitalTurnaround";
import type { TurnaroundSelection } from "../types/turnaroundStrategy";

const selection: TurnaroundSelection = {
  setting: { sellerKey: "seller", productLineId: null, mode: "observed", manualTurnaroundDays: 28, updatedAt: null },
  effectiveDays: 14,
  effectiveSource: "observed-seller",
  fallbackReasons: [],
  evidence: {
    scope: "seller", sourceProductLineId: null, attribution: "seller",
    reportAsOf: "2026-09-08T17:00:00.000Z", sourceFingerprint: "a".repeat(64),
    observationFrom: "2026-08-15T00:00:00.000Z", observationThrough: "2026-09-03T00:00:00.000Z",
    completedPurchaseCount: 20, completedCents: 200_000, waitingCents: 0, oldestWaitingDays: null,
    eligibleProceedsCents: 200_000, unallocatedProceedsCents: 0, oldestUnallocatedDays: null,
    reinvestedPercent: 100, completionCoveragePercent: 100,
    typicalDays: 14, slowerDays: 20, orderCoverageFinishedAt: "2026-09-08T17:30:00.000Z",
    orderObservedFrom: "2026-08-15T00:00:00.000Z", orderObservedThrough: "2026-09-03T00:00:00.000Z", confidence: "medium",
    limitations: [],
  },
};
const html = renderToStaticMarkup(<CapitalTurnaround selection={selection} busy={false} onSave={() => undefined} />);
assert.match(html, /Using 14\.0 days · observed seller/);
assert.match(html, /14\.0 days/);
assert.match(html, /20\.0 days/);
assert.match(html, /20 purchases/);
assert.match(html, /medium confidence · \$2,000\.00 completed/);
assert.match(html, /Manual days/);
assert.doesNotMatch(html, /Manual days retained/);

const fallback = renderToStaticMarkup(<CapitalTurnaround selection={{ ...selection, effectiveDays: 28,
  effectiveSource: "manual-fallback", fallbackReasons: ["Known proceeds remain waiting."],
  evidence: { ...selection.evidence!, waitingCents: 4_000, oldestWaitingDays: 3 } }} busy={false} onSave={() => undefined} />);
assert.match(fallback, /Using 28\.0 days · manual fallback/);
assert.match(fallback, /Manual days retained: Known proceeds remain waiting\./);
assert.match(fallback, /\$40\.00/);
assert.match(fallback, /oldest 3\.0 days/);

const none = renderToStaticMarkup(<CapitalTurnaround selection={{ ...selection, evidence: null, effectiveDays: 28,
  effectiveSource: "manual-fallback", fallbackReasons: ["No report."] }} busy={false} error="Rebuild failed" onSave={() => undefined} />);
assert.match(none, /No completed sale-to-publication cycles yet/);
assert.match(none, /Rebuild failed/);
console.log("PASS capital turnaround renders observed, fallback, and missing evidence states");
