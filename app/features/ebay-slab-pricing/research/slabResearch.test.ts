import assert from "node:assert/strict";
import fixture from "../identity/fixtures/alt-cert-110185364.json";
import { parseAltCertificate } from "../identity/altIdentityProvider.server";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import { researchTarget } from "./slabResearch.server";
import { defaultResearchWindow } from "../components/slabClient";
const candidate = parseAltCertificate(JSON.stringify(fixture))!;
const record: StoredSlabIdentity = {
  ...candidate,
  id: "00000000-0000-0000-0000-000000000001",
  candidate,
  identity: null,
  status: "needs-review",
  reviewReasons: ["confirmation-required"],
  valuationGroupKey: null,
  revision: 1,
  decisionSource: "alt",
  decisionNote: null,
  updatedAt: new Date("2026-09-05T12:00:00Z"),
};
const before = JSON.stringify(record);
const ten = researchTarget(record, "10");
assert.equal(ten.identity!.grading.number, 10);
assert.equal(ten.identity!.grading.label, "PSA 10");
assert.equal(ten.status, "needs-review");
assert.equal(researchTarget(record, "owned").identity!.grading.number, 1);
assert.equal(JSON.stringify(record), before);
assert.equal(
  ten.identity!.providerAsset!.id,
  candidate.identity.providerAsset!.id,
);
for (const grade of ["9.5", "11", "0", "garbage", "10.0"])
  assert.throws(() => researchTarget(record, grade));
assert.throws(() =>
  researchTarget(
    {
      ...record,
      candidate: {
        ...candidate,
        identity: {
          ...candidate.identity,
          grading: { ...candidate.identity.grading, grader: "CGC" },
        },
      },
    },
    "10",
  ),
);
assert.deepEqual(defaultResearchWindow(new Date("2026-09-06T01:00:00Z")), {
  from: "2025-09-05",
  to: "2026-09-05",
});
console.log(
  "PASS research grades never mutate or confirm the owned slab, unsupported grade mappings abstain, and windows use the research timezone",
);
