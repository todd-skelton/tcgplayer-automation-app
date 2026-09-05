import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { getPool } from "~/core/db/database.server";
import {
  requestEvidence,
  claimEvidenceJob,
  completeEvidenceJob,
  cancelEvidenceRefresh,
  evidenceStatuses,
  failEvidenceJob,
  getEvidenceRevision,
  cleanEvidenceCache,
  retainEvidenceRevisions,
} from "./evidenceRefreshStore.server";
import { runEvidenceJob } from "./evidenceRefreshWorker.server";
import { ProviderRequestError } from "../connections/providerRequest.server";
import { refreshSpec, refreshPayload } from "./evidenceRefresh.test";

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
const admin = new pg.Client({ connectionString: url.toString() });
const schema = `slab_evidence_test_${randomUUID().replaceAll("-", "")}`;
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool();
try {
  await db.query(
    await readFile("db/migrations/027_add_slab_evidence_refreshes.sql", "utf8"),
  );
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      requestEvidence(Array.from({ length: 50 }, () => refreshSpec)),
    ),
  );
  const first = concurrent[0][0];
  assert.ok(
    concurrent.every(
      (rows) => rows.length === 1 && rows[0].runId === first.runId,
    ),
  );
  const claims = await Promise.all(
    Array.from({ length: 4 }, () => claimEvidenceJob()),
  );
  assert.equal(claims.filter(Boolean).length, 1);
  let calls = 0;
  const fetch = async () => {
    calls++;
    return refreshPayload;
  };
  const job = claims.find(Boolean)!;
  assert.equal(await runEvidenceJob(job, { fetch }), true);
  const warm = (
    await requestEvidence(Array.from({ length: 50 }, () => refreshSpec))
  )[0];
  assert.equal(warm.stale, false);
  assert.equal(warm.latestRevision, first.runId);
  assert.equal(await claimEvidenceJob(), null);
  assert.equal(calls, 1);
  const revision = (await getEvidenceRevision(first.runId))!;
  assert.equal(
    revision.payload.kind === "alt-sales" &&
      revision.payload.data.coverage.limitPerGrade,
    16,
  );
  assert.equal(
    await completeEvidenceJob(job, refreshPayload, 10),
    false,
    "committed work is not duplicated",
  );
  await requestEvidence([refreshSpec], { force: true });
  const failure = (await claimEvidenceJob())!;
  await runEvidenceJob(failure, {
    fetch: async () => {
      throw new ProviderRequestError("reconnect-required");
    },
  });
  let status = (await evidenceStatuses([first.key]))[0];
  assert.equal(status.state, "failed");
  assert.equal(status.latestRevision, first.runId);
  assert.equal(status.stale, true);
  assert.equal(
    (await requestEvidence([refreshSpec]))[0].state,
    "failed",
    "viewing stale evidence cannot bypass retry cooldown",
  );
  await requestEvidence([refreshSpec], { force: true });
  const expired = (await claimEvidenceJob())!;
  await db.query(
    "UPDATE slab_evidence_refreshes SET lease_until = clock_timestamp() - interval '1 second' WHERE key = $1",
    [first.key],
  );
  const recovered = (await claimEvidenceJob())!;
  assert.equal(recovered.runId, expired.runId);
  assert.notEqual(recovered.leaseId, expired.leaseId);
  assert.equal(await completeEvidenceJob(expired, refreshPayload, 1), false);
  assert.equal(await runEvidenceJob(recovered, { fetch }), true);
  await requestEvidence([refreshSpec], { force: true });
  const cancelled = (await claimEvidenceJob())!;
  await cancelEvidenceRefresh(cancelled.key, cancelled.runId);
  assert.equal(await completeEvidenceJob(cancelled, refreshPayload, 1), false);
  assert.equal(await claimEvidenceJob(), null);
  await requestEvidence([refreshSpec], { force: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const failing = (await claimEvidenceJob())!;
    assert.equal(failing.attempts, attempt);
    await failEvidenceJob(failing, "unavailable", true);
    await db.query(
      "UPDATE slab_evidence_refreshes SET available_at = clock_timestamp() - interval '1 second' WHERE key = $1",
      [first.key],
    );
  }
  status = (await evidenceStatuses([first.key]))[0];
  assert.equal(status.state, "failed");
  assert.equal(await claimEvidenceJob(), null);
  await requestEvidence([refreshSpec], { force: true });
  const interrupted = (await claimEvidenceJob())!;
  const stopped = new AbortController();
  stopped.abort();
  await runEvidenceJob(interrupted, { fetch, signal: stopped.signal });
  assert.equal(
    (await evidenceStatuses([first.key]))[0].state,
    "queued",
    "shutdown leaves resumable work",
  );
  await db.query(
    "UPDATE slab_evidence_refreshes SET state = 'running', attempts = 3, lease_until = clock_timestamp() - interval '1 second' WHERE key = $1",
    [first.key],
  );
  assert.equal(await claimEvidenceJob(), null);
  assert.equal(
    (await evidenceStatuses([first.key]))[0].errorCode,
    "lease-expired",
  );
  await retainEvidenceRevisions([first.runId]);
  await db.query(
    "UPDATE slab_evidence_revisions SET created_at = clock_timestamp() - interval '100 days'",
  );
  await db.query(
    "UPDATE slab_evidence_refreshes SET updated_at = clock_timestamp() - interval '100 days'",
  );
  await cleanEvidenceCache();
  assert.ok(
    await getEvidenceRevision(first.runId),
    "recommendation evidence survives compaction",
  );
  assert.ok(
    await getEvidenceRevision(recovered.runId),
    "latest revision survives compaction",
  );
  await db.query("UPDATE slab_evidence_revisions SET retained = false");
  const cleaned = await cleanEvidenceCache();
  assert.equal(cleaned.keysRemoved, 1);
  assert.equal((await evidenceStatuses([first.key])).length, 0);
  await requestEvidence([refreshSpec]);
  const inFlightJob = (await claimEvidenceJob())!;
  let notifyStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let aborted = false;
  const inFlight = runEvidenceJob(inFlightJob, {
    fetch: async (_spec, signal) => {
      notifyStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("cancelled test request"));
          },
          { once: true },
        ),
      );
    },
  });
  await fetchStarted;
  await cancelEvidenceRefresh(inFlightJob.key, inFlightJob.runId);
  assert.equal(await inFlight, false);
  assert.equal(aborted, true, "cancellation aborts in-flight provider I/O");
  assert.equal(await getEvidenceRevision(inFlightJob.runId), null);
  const low = { ...refreshSpec, assetId: "priority-low" };
  const high = { ...refreshSpec, assetId: "priority-high" };
  await requestEvidence([low], { priority: 0 });
  const [highStatus] = await requestEvidence([high], { priority: 100 });
  await requestEvidence([low], { priority: 300 });
  const promoted = (await claimEvidenceJob())!;
  assert.equal(
    "assetId" in promoted.spec && promoted.spec.assetId,
    "priority-low",
  );
  await cancelEvidenceRefresh(promoted.key, promoted.runId);
  await cancelEvidenceRefresh(highStatus.key, highStatus.runId);
  const started = performance.now();
  const workload = Array.from({ length: 50 }, (_, i) => ({
    ...refreshSpec,
    assetId: `asset-${Math.floor(i / 5)}`,
  }));
  const statuses = await requestEvidence(workload);
  assert.equal(statuses.length, 10);
  const requestMs = performance.now() - started;
  let workflows = 0;
  while (true) {
    const next = await claimEvidenceJob();
    if (!next) break;
    await runEvidenceJob(next, {
      fetch: async (spec) => {
        workflows++;
        return {
          ...refreshPayload,
          data: {
            ...refreshPayload.data,
            sales: refreshPayload.data.sales.map((row) => ({
              ...row,
              assetId: "assetId" in spec ? spec.assetId : row.assetId,
            })),
          },
        };
      },
    });
  }
  const warmStarted = performance.now();
  assert.equal(
    (await requestEvidence(workload)).filter((row) => !row.stale).length,
    10,
  );
  assert.equal(workflows, 10);
  assert.equal(await claimEvidenceJob(), null);
  console.log(
    `Evidence workload: 50 slabs / 10 card requests; enqueue ${Math.round(requestMs)}ms; warm cache ${Math.round(performance.now() - warmStarted)}ms; provider workflows ${workflows}.`,
  );
  await db.query(
    `INSERT INTO slab_evidence_refreshes (key, spec, state, run_id)
    SELECT lpad(to_hex(n),64,'0'), $1, 'idle', gen_random_uuid() FROM generate_series(1,10000) n`,
    [JSON.stringify(refreshSpec)],
  );
  await db.query("ANALYZE slab_evidence_refreshes");
  const plan = await db.query(
    "EXPLAIN (ANALYZE, FORMAT JSON) SELECT key FROM slab_evidence_refreshes WHERE key = ANY($1::text[])",
    [statuses.map((row) => row.key)],
  );
  assert.ok(
    JSON.stringify(plan.rows[0]).includes("slab_evidence_refreshes_pkey"),
    "indexed lookup at realistic cache cardinality",
  );
  console.log(
    `Evidence indexed read plan: ${plan.rows[0]["QUERY PLAN"][0].Plan["Node Type"]}; execution ${plan.rows[0]["QUERY PLAN"][0]["Execution Time"]}ms.`,
  );
  console.log(
    "PASS concurrent refresh coalescing, warm cache, immutable revisions, restart, cancellation, retries, stale evidence, retention and workload",
  );
} finally {
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
