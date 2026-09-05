import assert from "node:assert/strict";
import { createSlabIdentityAction } from "../routes/api.slab-identities.server";
import fixture from "./fixtures/alt-cert-110185364.json";
import {
  parseAltCertificate,
  createAltIdentityProvider,
} from "./altIdentityProvider.server";
import {
  createSlabIdentityService,
  valuationGroupKey,
  type IdentityStore,
} from "./slabIdentityService.server";
import {
  identityConflicts,
  isCurrentIdentity,
  normalizeCertificate,
  parseSlabIdentity,
  type StoredSlabIdentity,
} from "./slabIdentity";
import { createProviderRequest } from "../connections/providerRequest.server";

const candidate = parseAltCertificate(
  JSON.stringify({ ...fixture, researchGrade: "10.0" }),
)!;
assert.equal(candidate.certificateNumber, "110185364");
assert.equal(candidate.identity.grading.number, 1);
assert.equal(candidate.identity.grading.encoding, "1.0");
assert.equal(
  candidate.identity.providerAsset?.id,
  "20c46c8c-4290-4953-b76f-5892bb442f87",
);
assert.equal(candidate.identity.card.language, null);
assert.equal(candidate.identity.card.edition, null);
assert.equal(candidate.identity.card.finish, "Reverse Holo");
assert.deepEqual(identityConflicts(candidate.identity, { gradeNumber: 10 }), [
  "inventory-grade-mismatch",
]);
assert.equal(parseAltCertificate('{"data":{"cert":null}}'), null);
for (const body of [
  "null",
  "{}",
  '{"data":{"cert":{}}}',
  '{"data":{},"errors":[{"message":"schema"}]}',
]) {
  assert.throws(() => parseAltCertificate(body), {
    status: "invalid-response",
  });
}
for (const gradingCompany of ["CGC", "BGS"]) {
  for (const gradeNumber of ["0.0", "10.5", "10.0"]) {
    const result = parseAltCertificate(
      JSON.stringify({
        data: { cert: { ...fixture.data.cert, gradingCompany, gradeNumber } },
      }),
    )!;
    assert.equal(result.identity.grading.number, null);
    assert.equal(result.identity.grading.label, null);
    assert.equal(result.identity.grading.encoding, gradeNumber);
  }
}
const grade = (label: string) => ({
  ...candidate.identity,
  grading: {
    ...candidate.identity.grading,
    grader: "CGC",
    encoding: "10.0",
    number: 10,
    label,
  },
});
assert.notEqual(
  valuationGroupKey(grade("Gem Mint 10")),
  valuationGroupKey(grade("Pristine 10")),
);
assert.notEqual(
  valuationGroupKey(grade("BGS Pristine")),
  valuationGroupKey(grade("BGS Black Label")),
);
for (const field of ["language", "edition", "stamp"] as const) {
  assert.notEqual(
    valuationGroupKey(candidate.identity),
    valuationGroupKey({
      ...candidate.identity,
      card: { ...candidate.identity.card, [field]: "different" },
    }),
  );
}
assert.deepEqual(
  identityConflicts(candidate.identity, {
    language: "Japanese",
    edition: "1st Edition",
    stamp: "Promo",
  }),
  [
    "inventory-language-mismatch",
    "inventory-edition-mismatch",
    "inventory-stamp-mismatch",
  ],
);
assert.deepEqual(
  normalizeCertificate({ grader: " psa ", certificateNumber: "001234" }),
  { grader: "PSA", certificateNumber: "001234" },
);
assert.throws(() =>
  parseSlabIdentity({
    ...candidate.identity,
    grading: { ...candidate.identity.grading, number: 10.5 },
  }),
);

let record: StoredSlabIdentity | null = null;
let calls = 0;
const store: IdentityStore = {
  find: async () => record,
  saveCandidate: async (certificate, value, reasons) =>
    (record = {
      ...certificate,
      id: "slab",
      candidate: value,
      identity: null,
      status: "needs-review",
      reviewReasons: reasons,
      valuationGroupKey: null,
      revision: 1,
      decisionSource: "alt",
      decisionNote: null,
      updatedAt: new Date(),
    }),
  confirm: async (_certificate, revision, identity, groupKey, note) => {
    if (!record || record.revision !== revision) return null;
    return (record = {
      ...record,
      identity,
      valuationGroupKey: groupKey,
      revision: revision + 1,
      status: "confirmed",
      reviewReasons: [],
      decisionNote: note,
      decisionSource: "manual",
    });
  },
};
const service = createSlabIdentityService({
  store,
  lookupCertificate: async () => {
    calls++;
    return candidate;
  },
});
const input = { grader: "PSA", certificateNumber: "110185364" };
const found = await service.lookup(input);
await assert.rejects(service.lookup({ ...input, certificateNumber: " " }), {
  code: "invalid-input",
});
await assert.rejects(
  service.lookup(input, { expected: { gradeNumber: Infinity } }),
  { code: "invalid-input" },
);
assert.equal(found.record.status, "needs-review");
assert.ok(found.reviewReasons.includes("confirmation-required"));
const confirmed = await service.confirm(
  input,
  1,
  candidate.identity,
  "Checked certificate and card image",
);
await service.lookup(input);
assert.equal(calls, 1);
const conflict = await service.lookup(input, {
  expected: { language: "Japanese" },
});
assert.ok(conflict.reviewReasons.includes("inventory-language-mismatch"));
const oldReference = {
  slabId: confirmed.id,
  revision: confirmed.revision,
  valuationGroupKey: confirmed.valuationGroupKey!,
};
assert.equal(isCurrentIdentity(confirmed, oldReference), true);
const corrected = await service.confirm(
  input,
  confirmed.revision,
  {
    ...candidate.identity,
    card: { ...candidate.identity.card, language: "English" },
  },
  "Verified language",
);
assert.equal(isCurrentIdentity(corrected, oldReference), false);
await assert.rejects(
  service.confirm(input, confirmed.revision, candidate.identity, "stale tab"),
  { code: "conflict" },
);
record = null;
const mismatch = await service.lookup({ ...input, grader: "CGC" });
assert.ok(mismatch.reviewReasons.includes("grader-mismatch"));
await assert.rejects(
  service.confirm(
    { ...input, grader: "CGC" },
    1,
    candidate.identity,
    "wrong grader",
  ),
  { code: "invalid-input" },
);
record = null;
const wrongCert = await createSlabIdentityService({
  store,
  lookupCertificate: async () => ({ ...candidate, certificateNumber: "other" }),
}).lookup(input);
assert.ok(wrongCert.reviewReasons.includes("certificate-mismatch"));
record = null;
const missing = await createSlabIdentityService({
  store,
  lookupCertificate: async () => null,
}).lookup(input);
assert.deepEqual(missing.reviewReasons, ["certificate-not-found"]);
await service.confirm(
  input,
  1,
  candidate.identity,
  "Manual identity from the certificate and image",
);

let requestBody = "";
const provider = createAltIdentityProvider(
  createProviderRequest(
    {
      claim: async () => ({
        id: "fixture",
        revision: 1,
        credential: "fixture",
        userAgent: "",
      }),
      release: async () => {},
    },
    async (_url, init) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify(fixture));
    },
  ),
);
assert.equal(
  (await provider(input.certificateNumber))?.identity.grading.number,
  1,
);
assert.deepEqual(JSON.parse(requestBody).variables, {
  certNumber: "110185364",
});
{
  const action = createSlabIdentityAction(service);
  const submit = (body: unknown, origin = "http://localhost") =>
    action({
      request: new Request("http://localhost/api/slab-identities", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  assert.equal(
    (await submit({ intent: "lookup", ...input }, "https://foreign.example"))
      .init?.status,
    403,
  );
  assert.equal(
    (await submit({ intent: "lookup", ...input })).init?.status,
    200,
  );
  assert.equal(
    (
      await submit({
        intent: "confirm",
        ...input,
        revision: 1,
        identity: candidate.identity,
        note: "Stale decision",
      })
    ).init?.status,
    409,
  );
  assert.equal(
    (await submit({ intent: "lookup", ...input, expected: [] })).init?.status,
    400,
  );
  const failed = await createSlabIdentityAction({
    ...service,
    lookup: async () => {
      throw new Error("private response");
    },
  })({
    request: new Request("http://localhost/api/slab-identities", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: JSON.stringify({ intent: "lookup", ...input }),
    }),
  });
  assert.equal(failed.init?.status, 500);
  assert.ok(!JSON.stringify(failed).includes("private response"));
}
console.log(
  "PASS certificate identity, explicit grade labels, cached confirmation, conflicts and correction invalidation",
);
