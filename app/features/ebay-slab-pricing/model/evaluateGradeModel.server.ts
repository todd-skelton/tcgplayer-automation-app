import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { median, type GradeSale } from "./gradeModel";
import { evaluateGradeModel } from "./gradeModelEvaluation";
import policy from "./gradeModelPolicy.json";
import fixture from "./fixtures/initial-grade-diagnostic.json";

export function reproduceGradeDiagnostic() {
  const cards = fixture.pairs.map((pair) => {
    const ten = fixture.observations.filter(
      (r) => r.cardId === pair.card && r.grade === 10,
    );
    const nine = fixture.observations.filter(
      (r) => r.cardId === pair.card && r.grade === 9,
    );
    const median10 = median(ten.map((r) => r.itemPrice + r.shipping))!;
    const median9 = median(nine.map((r) => r.itemPrice + r.shipping))!;
    return {
      card: pair.card,
      count10: ten.length,
      count9: nine.length,
      median10,
      median9,
      ratio: median10 / median9,
    };
  });
  const results = cards.map((card) => {
    const ratio = Math.exp(
      median(
        cards
          .filter((other) => other.card !== card.card)
          .map((other) => Math.log(other.ratio)),
      )!,
    );
    const predicted9 = card.median10 / ratio;
    return {
      ...card,
      predicted9,
      relativeError: Math.abs(predicted9 / card.median9 - 1),
    };
  });
  return {
    kind: "historical-four-card-diagnostic",
    isForwardValidation: false,
    priceBasis: "reported-item-plus-shipping",
    results,
    meanAbsolutePercentageError:
      (100 * results.reduce((sum, row) => sum + row.relativeError, 0)) /
      results.length,
  };
}
export async function writeGradeEvaluation() {
  const sales: GradeSale[] = fixture.observations.map((row) => ({
    eventId: row.eventId,
    cardId: row.cardId,
    cohort: fixture.cohort,
    grade: row.grade,
    soldOn: row.soldOn,
    capturedAt: row.capturedAt,
    amount: row.itemPrice + row.shipping,
    currency: "USD",
    basis: "item-plus-shipping",
    kind: "listing-average",
    quantity: row.quantity,
    verified: false,
    sourceRevision: row.sourceRevision,
  }));
  const dates = {
    fitCutoff: "2026-07-01T00:00:00Z",
    calibrationEnd: "2026-08-01T00:00:00Z",
    testEnd: "2026-09-05T00:00:00Z",
    asOf: fixture.capturedAt,
  };
  const forward = evaluateGradeModel(sales, dates);
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(fixture))
    .digest("hex");
  const artifact = {
    version: "slab-grade-evaluation-2026-09-05-v1",
    evaluatedAsOf: fixture.capturedAt,
    policy,
    lineage: {
      sourceHash,
      sourceRevision: "initial-ebay-evaluation-2026-09-05",
      observations: sales.length,
      priceBasis: "USD item-plus-shipping",
    },
    matching: {
      titleCompatible: sales.length,
      verified: 0,
      missingEventIds: sales.filter((s) => !s.eventId).length,
      precision: null,
      precisionReason: "No independently verified certification ground truth",
    },
    diagnostic: reproduceGradeDiagnostic(),
    forward: { ...forward, scores: undefined, lineage: undefined },
    status: "baseline-only",
    enabledCohorts: [],
    unsupported: [
      {
        cohort: "Japanese Terastal Festival ex PSA 9/10",
        reasons: [
          "unverified-identities",
          "unknown-edition-finish-stamp",
          "no-pre-cutoff-snapshots",
          "insufficient-test-cards-and-transactions",
        ],
        direct: { forecasts: 0, error: null, intervalCoverage: null },
        ratio: { forecasts: 0, error: null, intervalCoverage: null },
        fitted: { forecasts: 0, error: null, intervalCoverage: null },
      },
    ],
    limitations: fixture.limitations,
  };
  await writeFile(
    new URL(
      "../../../../docs/slab-grade-model-evaluation.json",
      import.meta.url,
    ),
    JSON.stringify(artifact, null, 2) + "\n",
  );
  await writeFile(
    new URL("./gradeModelRegistry.json", import.meta.url),
    JSON.stringify(
      {
        version: artifact.version,
        policyVersion: policy.version,
        sourceHash,
        status: "baseline-only",
        models: [],
        reason:
          "No cohort has verified, time-separated evidence sufficient for adoption.",
      },
      null,
      2,
    ) + "\n",
  );
  return artifact;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await writeGradeEvaluation();
  console.log(
    JSON.stringify({
      diagnosticMeanAbsolutePercentageError:
        result.diagnostic.meanAbsolutePercentageError,
      inputObservations: result.lineage.observations,
      verifiedObservations: result.matching.verified,
      eligibleForwardEvents: result.forward.eligibleUniqueEvents,
      status: result.status,
      enabledCohorts: result.enabledCohorts,
    }),
  );
}
