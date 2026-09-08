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
const comparisonMarkup = renderToStaticMarkup(<ForecastGrading report={{
  ...report,
  models: [
    { family: "curve", version: "curve:v1", training: score, validation: { ...score, count: 30, brier: 0.2 }, reservedCount: 0 },
    { family: "buyer-choice", version: "buyer:v1", training: score, validation: { ...score, count: 30, brier: 0.3 }, reservedCount: 0 },
    { family: "condition-rate", version: "condition:v1", training: score, validation: { ...score, count: 20, brier: 0.01 }, reservedCount: 0 },
  ],
  pairedComparisons: [
    { left: "curve:v1", right: "buyer:v1", validationCount: 30, leftBrier: 0.2, rightBrier: 0.3 },
    { left: "curve:v1", right: "condition:v1", validationCount: 20, leftBrier: 0.4, rightBrier: 0.01 },
    { left: "buyer:v1", right: "condition:v1", validationCount: 20, leftBrier: 0.4, rightBrier: 0.01 },
  ],
}} />);
assert.match(comparisonMarkup, /curve · curve:v1/);
assert.match(comparisonMarkup, /buyer-choice · buyer:v1/);
assert.match(comparisonMarkup, /condition-rate · condition:v1/);
assert.match(comparisonMarkup, /curve:v1 Brier 0.2000 · buyer:v1 Brier 0.3000 · 30 paired/);
assert.match(comparisonMarkup, /curve:v1 Brier 0.4000 · condition:v1 Brier 0.0100 · 20 paired/);
assert.match(comparisonMarkup, /buyer:v1 Brier 0.4000 · condition:v1 Brier 0.0100 · 20 paired/);
const sparseMarkup = renderToStaticMarkup(<ForecastGrading report={{
  ...report,
  pairedComparisons: [
    { left: "curve:v1", right: "buyer:tiny", validationCount: 1, leftBrier: 0.4, rightBrier: 0.1 },
  ],
}} />);
assert.match(sparseMarkup, /curve:v1 vs buyer:tiny: 1 paired · need 20/);
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
