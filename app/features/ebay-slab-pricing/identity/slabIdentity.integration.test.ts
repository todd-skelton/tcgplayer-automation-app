// Opt-in local PostgreSQL test. All records live in a disposable schema.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { getPool } from "~/core/db/database.server";
import { slabIdentityStore } from "./slabIdentities.server";
import { createSlabIdentityService } from "./slabIdentityService.server";
import { parseAltCertificate } from "./altIdentityProvider.server";
import { isCurrentIdentity } from "./slabIdentity";
import fixture from "./fixtures/alt-cert-110185364.json";

dotenv.config({
  path: [".env.development.local", ".env.local", ".env.development", ".env"],
  quiet: true,
});
const url = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation",
);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "5433",
  "Use the local development database",
);
const admin = new pg.Client({ connectionString: url.toString() });
const schema = `slab_identity_test_${randomUUID().replaceAll("-", "")}`;
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool();
try {
  await db.query(
    await readFile("db/migrations/025_add_slab_identities.sql", "utf8"),
  );
  const candidate = parseAltCertificate(JSON.stringify(fixture))!;
  const cert = {
    grader: candidate.grader,
    certificateNumber: candidate.certificateNumber,
  };
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      slabIdentityStore.saveCandidate(cert, candidate, [
        "confirmation-required",
      ]),
    ),
  );
  assert.equal(
    new Set(results.map((result) => result.id)).size,
    1,
    "one physical item per grader/certificate",
  );
  const collision = await slabIdentityStore.saveCandidate(
    { ...cert, grader: "CGC" },
    candidate,
    ["grader-mismatch"],
  );
  assert.notEqual(collision.id, results[0].id);
  let remoteCalls = 0;
  const service = createSlabIdentityService({
    store: slabIdentityStore,
    lookupCertificate: async () => {
      remoteCalls++;
      return candidate;
    },
  });
  const confirmed = await service.confirm(
    cert,
    1,
    candidate.identity,
    "Verified fixture identity",
  );
  const loaded = await service.lookup(cert);
  assert.equal(loaded.record.status, "confirmed");
  assert.equal(remoteCalls, 0);
  const old = {
    slabId: confirmed.id,
    revision: confirmed.revision,
    valuationGroupKey: confirmed.valuationGroupKey!,
  };
  const decisions = await Promise.allSettled([
    service.confirm(
      cert,
      confirmed.revision,
      {
        ...candidate.identity,
        card: { ...candidate.identity.card, language: "English" },
      },
      "Verified language",
    ),
    service.confirm(
      cert,
      confirmed.revision,
      {
        ...candidate.identity,
        card: { ...candidate.identity.card, language: "Japanese" },
      },
      "Competing stale correction",
    ),
  ]);
  assert.equal(
    decisions.filter((decision) => decision.status === "fulfilled").length,
    1,
  );
  const rejected = decisions.find((decision) => decision.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" && rejected.reason.code === "conflict",
  );
  const current = await slabIdentityStore.find(cert);
  assert.ok(current);
  assert.equal(isCurrentIdentity(current, old), false);
  assert.notEqual(current.valuationGroupKey, old.valuationGroupKey);
  const delayed = await slabIdentityStore.saveCandidate(
    cert,
    null,
    ["certificate-not-found"],
    1,
  );
  assert.equal(delayed.revision, current.revision);
  assert.equal(delayed.status, "confirmed");
  assert.equal(
    delayed.candidate?.identity.grading.encoding,
    "1.0",
    "retain original provider provenance after manual correction",
  );
  console.log(
    "PASS concurrent physical-item deduplication, grader collisions, cached mapping, optimistic corrections and stale-provider fencing",
  );
} finally {
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
