import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { getPool } from "~/core/db/database.server";
import { slabIdentityStore } from "../identity/slabIdentities.server";
import { valuationGroupKey } from "../identity/slabIdentityService.server";
import {
  requestEvidence,
  claimEvidenceJob,
  completeEvidenceJob,
  cleanEvidenceCache,
} from "../evidence/evidenceRefreshStore.server";
import { getCompDecisions, saveCompDecision } from "./compDecisions.server";
import { compTarget, compSale } from "./screenComparables.test";
import { action } from "../routes/api.slab-comp-decisions.server";

dotenv.config({
  path: [".env.development.local", ".env.local", ".env.development", ".env"],
  quiet: true,
});
const url = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation",
);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.port === "5433" &&
    url.pathname === "/tcgplayer_automation",
);
const admin = new pg.Client({ connectionString: url.toString() }),
  schema = `slab_comp_test_${randomUUID().replaceAll("-", "")}`;
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool();
try {
  for (const name of [
    "025_add_slab_identities.sql",
    "027_add_slab_evidence_refreshes.sql",
    "030_add_slab_supply_observations.sql",
    "028_add_slab_comp_decisions.sql",
  ])
    await db.query(await readFile(`db/migrations/${name}`, "utf8"));
  const cert = {
    grader: compTarget.grader,
    certificateNumber: compTarget.certificateNumber,
  };
  const created = await slabIdentityStore.saveCandidate(cert, null, []);
  const target = (await slabIdentityStore.confirm(
    cert,
    created.revision,
    compTarget.identity!,
    valuationGroupKey(compTarget.identity!),
    "Verified fixture",
  ))!;
  const spec = {
    kind: "alt-sale-detail" as const,
    transactionId: compSale.providerId,
  };
  await requestEvidence([spec]);
  const job = (await claimEvidenceJob())!;
  await completeEvidenceJob(
    job,
    { kind: "alt-sale-detail", data: compSale },
    1,
  );
  const input = {
    slabId: target.id,
    identityRevision: target.revision,
    revisionId: job.runId,
    provider: compSale.provider,
    providerId: compSale.providerId,
    date: compSale.date,
    decision: "accept" as const,
    note: "Reviewed the exact sale",
    itemPrice: { amount: 100, currency: "USD" },
  };
  await assert.rejects(
    saveCompDecision({ ...input, providerId: "different-sale" }),
    /exact sale/,
  );
  await assert.rejects(
    saveCompDecision({ ...input, date: "2025-01-01" }),
    /exact sale/,
  );
  const saved = await saveCompDecision(input);
  assert.equal(saved.valuationGroupKey, target.valuationGroupKey);
  assert.equal(
    (await getCompDecisions(target.valuationGroupKey!, [job.runId])).length,
    1,
  );
  await saveCompDecision({
    ...input,
    decision: "exclude",
    note: "Changed review after checking title",
  });
  assert.equal(
    (await getCompDecisions(target.valuationGroupKey!, [job.runId]))[0]
      .decision,
    "exclude",
  );
  assert.equal(
    (await db.query("SELECT 1 FROM slab_comp_decisions")).rowCount,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT retained FROM slab_evidence_revisions WHERE id=$1",
        [job.runId],
      )
    ).rows[0].retained,
    true,
  );
  await requestEvidence([spec], { force: true });
  const next = (await claimEvidenceJob())!;
  await completeEvidenceJob(
    next,
    {
      kind: "alt-sale-detail",
      data: { ...compSale, price: { amount: 101, currency: "USD" } },
    },
    1,
  );
  assert.equal(
    (await getCompDecisions(target.valuationGroupKey!, [next.runId])).length,
    0,
    "new evidence does not inherit reviews",
  );
  const corrected = {
    ...target.identity!,
    card: { ...target.identity!.card, language: "Spanish" },
  };
  const updated = (await slabIdentityStore.confirm(
    cert,
    target.revision,
    corrected,
    valuationGroupKey(corrected),
    "Corrected language",
  ))!;
  assert.equal(
    (await getCompDecisions(updated.valuationGroupKey!, [job.runId])).length,
    0,
    "identity corrections do not inherit another group's review",
  );
  await assert.rejects(saveCompDecision(input), /Reload/);
  await db.query(
    "UPDATE slab_evidence_revisions SET created_at=clock_timestamp()-interval '100 days'",
  );
  await db.query(
    "UPDATE slab_evidence_refreshes SET updated_at=clock_timestamp()-interval '100 days'",
  );
  await cleanEvidenceCache();
  assert.equal(
    (await getCompDecisions(target.valuationGroupKey!, [job.runId])).length,
    1,
    "review and source survive cleanup",
  );
  const request = (body: unknown, origin = "http://localhost") =>
    new Request("http://localhost/api/slab-comp-decisions", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await action({ request: request(input, "http://elsewhere") })).init
      ?.status,
    403,
  );
  assert.equal((await action({ request: request(input) })).init?.status, 409);
  assert.equal((await action({ request: request(null) })).init?.status, 400);
  assert.equal(
    (await action({ request: request({ note: "x".repeat(20000) }) })).init
      ?.status,
    400,
  );
  console.log(
    "PASS comp decisions bind exact source/date/revision and current identity, preserve history, and enforce origin/body bounds",
  );
} finally {
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
