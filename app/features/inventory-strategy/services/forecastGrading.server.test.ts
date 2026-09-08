import assert from "node:assert/strict";
import type { ForecastEvaluationEvidence } from "~/features/pricing/domain/forecastEvaluation";
import { loadForecastGrading } from "./forecastGrading.server";

const evidence: ForecastEvaluationEvidence = {
  sellerKey: "synthetic-seller",
  evaluatedAt: "2026-09-01T00:00:00.000Z",
  orderHistory: {
    runId: "1", status: "complete", coveredFrom: "2026-01-01T00:00:00.000Z",
    cutoffAt: "2026-09-01T00:00:00.000Z", gaps: [],
  },
  spells: [], orderRevisions: [], exposure: [], fifo: [],
};
let evidenceReads = 0;
let saves = 0;
const source = {
  findEvidenceVersion: async () => "frozen-source-1",
  findMaterialEvidenceVersion: async () => "material-1",
  findEvidence: async () => { evidenceReads += 1; return evidence; },
  save: async () => { saves += 1; return { id: "1", created: saves === 1 }; },
};
const first = await loadForecastGrading("synthetic-seller", source);
const second = await loadForecastGrading("synthetic-seller", source);
assert.deepEqual(first, second);
assert.equal(first?.status, "abstained");
assert.equal(evidenceReads, 1, "unchanged frozen evidence is evaluated once");
assert.equal(saves, 1, "unchanged frozen evidence is persisted once");
assert.equal(await loadForecastGrading("", source), null);

console.log("PASS forecast evaluation loads and persists one result per frozen evidence version");
