import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { FORECAST_EVALUATION_POLICY, type ForecastEvaluationReport } from "~/features/pricing/domain/forecastEvaluation";
import { ForecastGrading } from "./ForecastGrading";

const score = { count: 2, soldShare: 0.5, expectedShare: 0.6, brier: 0.24, calibrationError: 0.1 };
const report = {
  policy: FORECAST_EVALUATION_POLICY,
  sellerKey: "synt-sC7Z0",
  evaluatedAt: "2026-09-01T00:00:00.000Z",
  fitCutoff: "2026-05-12T00:00:00.000Z",
  validationCutoff: "2026-08-04T00:00:00.000Z",
  evidenceFingerprint: "a".repeat(64),
  status: "abstained",
  statusReasons: ["validation_sample_below_minimum"],
  provenance: { runId: "1", status: "complete", coveredFrom: "2026-01-01T00:00:00.000Z", coveredThrough: "2026-09-01T00:00:00.000Z", cutoffAt: "2026-09-01T00:00:00.000Z", gaps: [] },
  coverage: {
    totalSpells: 4, includedSpells: 2, includedQuantity: 13, coverage: 0.5,
    excludedSpells: 2, excludedQuantity: 2,
    exclusions: { stock_removed: { spells: 1, quantity: 1 }, immature_window: { spells: 1, quantity: 1 } },
  },
  observations: [],
  models: [{ family: "curve", version: "curve:pooled-supply-v1", training: score, validation: score, reservedCount: 1 }],
  pairedComparisons: [],
  correction: null,
} satisfies ForecastEvaluationReport;

const markup = renderToStaticMarkup(<ForecastGrading report={report} />);
assert.match(markup, /21-day next sale/);
assert.match(markup, /inventory disappearance never counts as a sale/i);
assert.match(markup, /active forecast remains unchanged/i);
assert.match(markup, /stock removed: 1 spell/);
assert.match(markup, /curve:pooled-supply-v1/);
assert.match(markup, /No compatible held-out model pairs/);
const eligibleMarkup = renderToStaticMarkup(
  <ForecastGrading
    report={{ ...report, status: "eligible", statusReasons: [], evaluationId: "42" }}
    onActivate={() => undefined}
  />,
);
assert.match(eligibleMarkup, /Activate eligible correction/);
const activeMarkup = renderToStaticMarkup(
  <ForecastGrading
    report={report}
    activeCorrection={{
      version: "median-days-scale-v1:1.25",
      sellerKey: "synt-sC7Z0",
      sourceModelVersion: "pooled-supply-v1",
      medianDaysMultiplier: 1.25,
      evaluationId: "42",
    }}
    onRollback={() => undefined}
  />,
);
assert.match(activeMarkup, /Roll back correction/);
assert.equal(renderToStaticMarkup(<ForecastGrading report={null} />), "");

console.log("PASS forecast validation renders target, chronology, model versions, and exclusions");
