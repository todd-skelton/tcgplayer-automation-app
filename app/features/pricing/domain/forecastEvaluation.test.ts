import assert from "node:assert/strict";
import {
  FORECAST_EVALUATION_POLICY,
  constantHazardSaleProbability,
  evaluateForecastEvidence,
  type ForecastEvaluationEvidence,
  type PublicationForecastSpell,
} from "./forecastEvaluation";

const DAY = 86_400_000;
const evaluatedAt = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (daysBefore: number) => new Date(evaluatedAt - daysBefore * DAY).toISOString();
const forecast = (medianDays = 14, version = "pooled-supply-v1") => ({
  source: "publication_candidate",
  pricedAt: iso(200),
  pricingModelVersion: version,
  decision: {
    basis: "modeled",
    method: "profit-per-day",
    selectedPrice: 5,
    estimatedMedianSellDays: medianDays,
  },
  buyerChoiceForecast: { calibration: "choice-v1", medianSellDays: medianDays },
  conditionRateForecast: { method: "rate-v1", medianSellDays: medianDays },
});

function spell(
  id: number,
  sku: number,
  daysBefore: number,
  overrides: Partial<PublicationForecastSpell> = {},
): PublicationForecastSpell {
  const publishedAt = iso(daysBefore);
  return {
    publicationItemId: String(id), sellerKey: "synthetic-seller", sku,
    productLine: "Synthetic", productLineId: 1, publishedAt, nextPublishedAt: null,
    desiredPrice: 5, quantity: 3,
    forecastEvidence: { ...forecast(), pricedAt: publishedAt },
    forecastEvidenceProvenance: "recorded", ...overrides,
  };
}

function baseEvidence(spells: PublicationForecastSpell[]): ForecastEvaluationEvidence {
  const exposure = spells.flatMap((item) => {
    if (!item.publishedAt) return [];
    const published = Date.parse(item.publishedAt);
    return Array.from({ length: 4 }, (_, index) => ({
      observationId: `${item.publicationItemId}:${index}`,
      publicationItemId: item.publicationItemId,
      sku: item.sku,
      observedAt: new Date(published + (index + 1) * 6 * DAY).toISOString(),
      quantity: item.quantity,
    }));
  });
  return {
    sellerKey: "synthetic-seller", evaluatedAt: new Date(evaluatedAt).toISOString(),
    orderHistory: { runId: "1", status: "complete", coveredFrom: iso(365), coveredThrough: iso(0), cutoffAt: iso(0), gaps: [] },
    spells, orderRevisions: [], exposure,
    fifo: [...new Set(spells.map((item) => item.sku))].map((sku) => ({ sku, state: "settled", revisionIds: [`fifo:${sku}:1`], latestRecordedAt: iso(30) })),
  };
}

assert.equal(constantHazardSaleProbability(14, 14), 0.5);

const first = spell(1, 1, 80, { nextPublishedAt: iso(77) });
const second = spell(2, 1, 77);
const disappearance = spell(3, 2, 80);
const partial = spell(4, 3, 80);
const evidence = baseEvidence([first, second, disappearance, partial]);
evidence.orderRevisions.push(
  { orderId: "older-stock-order", orderNumber: "O1", revision: 1, observedAt: iso(74), orderTime: iso(75), orderTimeEvidence: "detail_canonical", lifecycle: "completed_paid", source: "tcgplayer_api", sku: 1, quantity: 1 },
  { orderId: "multi-unit-order", orderNumber: "O2", revision: 1, observedAt: iso(74), orderTime: iso(75), orderTimeEvidence: "detail_canonical", lifecycle: "completed_paid", source: "tcgplayer_api", sku: 3, quantity: 3 },
);
evidence.fifo.find((value) => value.sku === 1)!.settledOrderIds = ["older-stock-order"];
evidence.fifo.find((value) => value.sku === 3)!.settledOrderIds = ["multi-unit-order"];
const report = evaluateForecastEvidence(evidence);
assert.equal(report.coverage.exclusions.repriced_before_horizon?.spells, 1);
assert.equal(report.observations.find((item) => item.publicationItemId === "2")?.sold, true, "sale after repricing grades only the new spell");
assert.equal(report.observations.find((item) => item.publicationItemId === "4")?.orderEvidence?.quantity, 3);
assert.equal(report.observations.filter((item) => item.publicationItemId === "4").length, 1, "one multi-unit order is one event");
assert.equal(report.observations.find((item) => item.publicationItemId === "3")?.sold, false, "supported exposure is unsold; disappearance is never a sale");

const missingFifo = baseEvidence([spell(40, 40, 80)]);
missingFifo.fifo = [];
missingFifo.orderRevisions.push({
  orderId: "unsettled-order", orderNumber: "O-unsettled", revision: 1,
  observedAt: iso(74), orderTime: iso(75), orderTimeEvidence: "detail_canonical",
  lifecycle: "completed_paid", source: "tcgplayer_api", sku: 40, quantity: 1,
});
const missingFifoReport = evaluateForecastEvidence(missingFifo);
assert.equal(missingFifoReport.observations.length, 0);
assert.equal(missingFifoReport.coverage.exclusions.fifo_unavailable?.spells, 1,
  "a verified sale requires an attributable settled FIFO revision");

const removed = spell(5, 4, 80);
const removedEvidence = baseEvidence([removed]);
removedEvidence.exposure[1]!.quantity = 0;
const removedReport = evaluateForecastEvidence(removedEvidence);
assert.equal(removedReport.observations.length, 0);
assert.equal(removedReport.coverage.exclusions.stock_removed?.spells, 1);

const removedBeforeSale = baseEvidence([spell(51, 41, 80)]);
removedBeforeSale.exposure[0]!.quantity = 0;
removedBeforeSale.orderRevisions.push({
  orderId: "after-removal", orderNumber: "O-after", revision: 1,
  observedAt: iso(70), orderTime: iso(70), orderTimeEvidence: "detail_canonical",
  lifecycle: "completed_paid", source: "tcgplayer_api", sku: 41, quantity: 1,
});
const removedBeforeSaleReport = evaluateForecastEvidence(removedBeforeSale);
assert.equal(removedBeforeSaleReport.observations.length, 0);
assert.equal(removedBeforeSaleReport.coverage.exclusions.stock_removed?.spells, 1, "known removal closes a spell before a later sale");

const frozen = baseEvidence([spell(6, 5, 80)]);
frozen.orderRevisions.push({
  orderId: "future", orderNumber: "O3", revision: 2, observedAt: new Date(evaluatedAt + DAY).toISOString(),
  orderTime: iso(75), orderTimeEvidence: "detail_canonical", lifecycle: "completed_paid",
  source: "tcgplayer_api", sku: 5, quantity: 1,
});
assert.equal(evaluateForecastEvidence(frozen).observations[0]?.sold, false, "future revisions cannot backdate a sale");

const canceled = baseEvidence([spell(7, 6, 80)]);
canceled.orderRevisions.push({
  orderId: "corrected", orderNumber: "O4", revision: 2, observedAt: iso(10), orderTime: iso(75),
  orderTimeEvidence: "detail_canonical", lifecycle: "canceled", source: "tcgplayer_api", sku: 6, quantity: 1,
});
assert.equal(evaluateForecastEvidence(canceled).observations[0]?.sold, false, "late cancellation corrects the outcome without rewriting the forecast");

const training: PublicationForecastSpell[] = [];
const synthetic = baseEvidence(training);
for (let index = 0; index < 100; index += 1) {
  const daysBefore = index < 50
    ? 200 - index
    : index < 80
      ? 100 - (index - 50)
      : 20 - (index - 80) * 0.5;
  const item = spell(100 + index, 1000 + index, daysBefore, {
    quantity: 1,
    forecastEvidence: {
      ...forecast(7),
      pricedAt: iso(daysBefore),
    },
  });
  training.push(item);
}
synthetic.spells = training;
synthetic.fifo = training.map((item) => ({ sku: item.sku, state: "settled", revisionIds: [`fifo:${item.sku}`], latestRecordedAt: iso(20) }));
synthetic.exposure = baseEvidence(training).exposure;
// Fast baseline forecasts overpredict; all synthetic outcomes remain unsold,
// so the training-selected slower correction also improves validation.
const eligible = evaluateForecastEvidence(synthetic);
assert.equal(eligible.policy.minimumBrierImprovement, FORECAST_EVALUATION_POLICY.minimumBrierImprovement);
assert.ok(eligible.models.some((model) => model.version === "curve:pooled-supply-v1"));
assert.equal(eligible.correction?.medianDaysMultiplier, 1.25);
assert.equal(eligible.status, "eligible");
assert.ok(eligible.pairedComparisons.some((comparison) => comparison.validationCount > 0));
assert.ok(eligible.correction?.productLines[0]?.eligible, "a product line needs its own sample and held-out gates");

const hiddenValidationFailures = structuredClone(synthetic);
const validationFailures = Array.from({ length: 40 }, (_, index) => {
  const daysBefore = 48 - index * 0.45;
  const item = spell(500 + index, 5000 + index, daysBefore, {
    quantity: 1,
    forecastEvidence: { ...forecast(7), pricedAt: iso(daysBefore) },
  });
  return item;
});
hiddenValidationFailures.spells.push(...validationFailures);
hiddenValidationFailures.fifo.push(...validationFailures.map((item) => ({
  sku: item.sku, state: "settled" as const, revisionIds: [`fifo:${item.sku}`], latestRecordedAt: iso(20),
})));
const insufficientValidationCoverage = evaluateForecastEvidence(hiddenValidationFailures);
assert.equal(insufficientValidationCoverage.status, "abstained");
assert.ok(insufficientValidationCoverage.statusReasons.includes("validation_coverage_below_minimum"), "training coverage cannot hide unknown validation outcomes");

const changedVersion = structuredClone(synthetic);
(changedVersion.spells[0]!.forecastEvidence as any).pricingModelVersion = "curve-v2";
const separated = evaluateForecastEvidence(changedVersion);
assert.ok(separated.models.some((model) => model.version === "curve:curve-v2"));
assert.ok(separated.models.some((model) => model.version === "curve:pooled-supply-v1"));

const correctedSnapshot = structuredClone(synthetic);
const correctedEvidence = correctedSnapshot.spells[0]!.forecastEvidence as any;
correctedEvidence.policy = { forecastCorrection: { version: "median-days-scale-v1:1.25" } };
correctedEvidence.decision.forecastCorrectionVersion = "median-days-scale-v1:1.25";
const correctedSeparated = evaluateForecastEvidence(correctedSnapshot);
assert.ok(correctedSeparated.models.some((model) => model.version.includes("+correction:median-days-scale-v1:1.25")));
assert.ok(
  (correctedSeparated.models.find((model) => model.version === "curve:pooled-supply-v1")?.training.count ?? 0) <
    (eligible.models.find((model) => model.version === "curve:pooled-supply-v1")?.training.count ?? 0),
  "corrected history is not pooled into the raw runtime model",
);

const splitBoundary = baseEvidence([spell(900, 9900, 120)]);
const splitBoundaryReport = evaluateForecastEvidence(splitBoundary);
assert.equal(splitBoundaryReport.coverage.includedSpells, 0);
assert.equal(splitBoundaryReport.coverage.exclusions.outcome_after_split_cutoff?.spells, 1,
  "an outcome crossing the fit boundary is excluded instead of inflating coverage");

console.log("PASS forecast evaluation uses frozen next-sale evidence, chronology, and explicit censoring");
