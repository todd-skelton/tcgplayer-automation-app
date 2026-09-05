import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { normalizeEvidenceSpec, type EvidenceSpec } from "./evidenceRefresh";
import {
  compactEvidence,
  evidenceKey,
  validateEvidencePayload,
  type EvidencePayload,
} from "./evidenceRefreshProvider.server";
import { planSlabEvidence } from "./slabEvidenceRefresh.server";
import { parseAltSales } from "./altEvidenceProvider.server";
import salesFixture from "./fixtures/alt-sales.json";
import { parseAltCertificate } from "../identity/altIdentityProvider.server";
import certFixture from "../identity/fixtures/alt-cert-110185364.json";
import { valuationGroupKey } from "../identity/slabIdentityService.server";
import type { StoredSlabIdentity } from "../identity/slabIdentity";

export const refreshSpec: EvidenceSpec = {
  kind: "alt-sales",
  assetId: "cd3ecabf-7d43-4375-9428-1a7cdfe66426",
  window: { from: "2023-01-01", to: "2026-09-05" },
  limitPerGrade: 16,
};
export const refreshPayload: Extract<EvidencePayload, { kind: "alt-sales" }> = {
  kind: "alt-sales",
  data: parseAltSales(
    JSON.stringify(salesFixture),
    refreshSpec.assetId,
    refreshSpec.window,
    16,
    "2026-09-05T12:00:00.000Z",
  ),
};
assert.equal(
  evidenceKey(refreshSpec),
  evidenceKey({
    ...refreshSpec,
    window: { to: refreshSpec.window.to, from: refreshSpec.window.from },
  }),
);
assert.notEqual(
  evidenceKey(refreshSpec),
  evidenceKey({ ...refreshSpec, limitPerGrade: 8 }),
);
assert.notEqual(
  evidenceKey(refreshSpec),
  evidenceKey({
    ...refreshSpec,
    window: { ...refreshSpec.window, from: "2024-01-01" },
  }),
);
assert.throws(() =>
  normalizeEvidenceSpec({
    ...refreshSpec,
    window: { from: "2026-02-30", to: "2026-09-05" },
  }),
);
assert.throws(() =>
  normalizeEvidenceSpec({ ...refreshSpec, limitPerGrade: 17 }),
);
const compact = compactEvidence(refreshPayload);
assert.throws(() =>
  validateEvidencePayload(
    { ...refreshSpec, assetId: "wrong-asset" },
    refreshPayload,
  ),
);
assert.throws(() =>
  validateEvidencePayload(
    { ...refreshSpec, window: { ...refreshSpec.window, from: "2024-01-01" } },
    refreshPayload,
  ),
);
assert.throws(() =>
  validateEvidencePayload(
    {
      kind: "ebay-sales",
      groupKey: "a".repeat(64),
      keywords: "Ponyta",
      window: refreshSpec.window,
      offset: 0,
      limit: 50,
      timezone: "America/Chicago",
    },
    {
      kind: "ebay-sales",
      data: {
        status: "active-fallback",
        keywords: "Ponyta",
        asOf: "2026-09-05",
      },
    },
  ),
);
assert.equal(
  compact.payload.kind === "alt-sales" &&
    compact.payload.data.coverage.limitPerGrade,
  16,
);
assert.equal(
  compact.payload.kind === "alt-sales" &&
    compact.payload.data.coverage.complete,
  false,
);
const sale = refreshPayload.data.sales[0];
assert.equal(
  compactEvidence({
    ...refreshPayload,
    data: { ...refreshPayload.data, sales: [sale, sale] },
  }).observations,
  1,
);
assert.equal(
  compactEvidence({
    ...refreshPayload,
    data: {
      ...refreshPayload.data,
      sales: [sale, { ...sale, date: "2024-01-02" }],
    },
  }).observations,
  2,
);
assert.throws(() =>
  compactEvidence({
    ...refreshPayload,
    data: {
      ...refreshPayload.data,
      sales: [sale, { ...sale, price: { amount: 999, currency: "USD" } }],
    },
  }),
);
const candidate = parseAltCertificate(JSON.stringify(certFixture))!;
const slabs: StoredSlabIdentity[] = Array.from({ length: 50 }, (_, i) => {
  const identity = {
    ...candidate.identity,
    providerAsset: {
      provider: "alt" as const,
      id: `asset-${Math.floor(i / 5)}`,
      title: null,
    },
    grading: {
      ...candidate.identity.grading,
      number: (i % 5) + 1,
      label: `Grade ${(i % 5) + 1}`,
    },
  };
  return {
    id: randomUUID(),
    grader: "PSA",
    certificateNumber: String(i),
    candidate: null,
    identity,
    status: "confirmed",
    reviewReasons: [],
    valuationGroupKey: valuationGroupKey(identity),
    revision: 1,
    decisionSource: "manual",
    decisionNote: "test",
    updatedAt: new Date(),
  };
});
const plan = planSlabEvidence(slabs, refreshSpec.window);
assert.equal(
  plan.requests.filter((spec) => spec.kind === "alt-sales").length,
  10,
  "fifty slabs share ten all-grade requests",
);
assert.equal(
  plan.requests.filter((spec) => spec.kind === "ebay-sales").length,
  50,
);
assert.equal(
  planSlabEvidence(
    [{ ...slabs[0], status: "needs-review" }],
    refreshSpec.window,
  ).requests.length,
  0,
);
console.log(
  "PASS evidence cache identity, context, windows, caps, event identity and fifty-slab request composition",
);
