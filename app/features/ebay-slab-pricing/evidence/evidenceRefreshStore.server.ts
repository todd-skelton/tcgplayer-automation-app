import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  recordSupplyScan,
  cleanSupplyObservations,
  getSupplyScan,
} from "../supply/supplyObservations.server";
import {
  getPool,
  withTransaction,
  type Queryable,
} from "~/core/db/database.server";
import {
  EVIDENCE_TTL_SECONDS,
  EvidenceRefreshError,
  normalizeEvidenceSpec,
  type EvidenceSpec,
  type RefreshState,
} from "./evidenceRefresh";
import {
  compactEvidence,
  evidenceKey,
  validateEvidencePayload,
  type EvidencePayload,
} from "./evidenceRefreshProvider.server";

const QUERY_TIMEOUT = { query_timeout: 10_000 };
async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  executor?: Queryable,
): Promise<T[]> {
  return (
    await (executor ?? getPool()).query<T>({ ...QUERY_TIMEOUT, text, values })
  ).rows;
}
async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  return (await query<T>(text, values))[0] ?? null;
}

export type EvidenceStatus = {
  key: string;
  spec: EvidenceSpec;
  state: RefreshState;
  runId: string;
  latestRevision: string | null;
  fetchedAt: Date | null;
  expiresAt: Date | null;
  errorCode: string | null;
  attempts: number;
  durationMs: number | null;
  stale: boolean;
};
export type EvidenceJob = {
  key: string;
  spec: EvidenceSpec;
  runId: string;
  leaseId: string;
  attempts: number;
};
const STATUS = `key, spec, state, run_id AS "runId", latest_revision AS "latestRevision", fetched_at AS "fetchedAt", expires_at AS "expiresAt",
  error_code AS "errorCode", attempts, duration_ms AS "durationMs", (expires_at IS NULL OR expires_at <= clock_timestamp() OR state = 'failed') AS stale`;
function keysInput(keys: string[]) {
  if (
    !Array.isArray(keys) ||
    keys.length > 200 ||
    keys.some((key) => !/^[a-f0-9]{64}$/.test(key))
  )
    throw new EvidenceRefreshError("Choose at most 200 evidence keys.");
  return [...new Set(keys)];
}
export async function evidenceStatuses(
  keys: string[],
): Promise<EvidenceStatus[]> {
  return query(
    `SELECT ${STATUS} FROM slab_evidence_refreshes WHERE key = ANY($1::text[]) ORDER BY key`,
    [keysInput(keys)],
  );
}
export async function requestEvidence(
  specs: EvidenceSpec[],
  options: { force?: boolean; priority?: number } = {},
) {
  if (!Array.isArray(specs) || specs.length > 200)
    throw new EvidenceRefreshError("Choose at most 200 evidence requests.");
  const priority = options.priority ?? 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > 300)
    throw new EvidenceRefreshError("Invalid refresh priority.");
  const entries = new Map<
    string,
    { key: string; spec: EvidenceSpec; run_id: string }
  >();
  for (const input of specs) {
    const spec = normalizeEvidenceSpec(input),
      key = evidenceKey(spec);
    entries.set(key, { key, spec, run_id: randomUUID() });
  }
  if (!entries.size) return [];
  await query(
    `INSERT INTO slab_evidence_refreshes (key, spec, run_id, state, priority)
    SELECT x.key, x.spec, x.run_id, 'queued', $2 FROM jsonb_to_recordset($1::jsonb) AS x(key text, spec jsonb, run_id uuid)
    ON CONFLICT (key) DO UPDATE SET state = 'queued', run_id = EXCLUDED.run_id, priority = EXCLUDED.priority,
      attempts = 0, available_at = clock_timestamp(), lease_id = NULL, lease_until = NULL, error_code = NULL, updated_at = clock_timestamp()
    WHERE slab_evidence_refreshes.state NOT IN ('queued', 'running')
      AND ($3 OR (slab_evidence_refreshes.available_at <= clock_timestamp()
        AND (slab_evidence_refreshes.expires_at IS NULL OR slab_evidence_refreshes.expires_at <= clock_timestamp())))`,
    [JSON.stringify([...entries.values()]), priority, options.force === true],
  );
  // Warm reads and coalesced requests never issue provider work.
  await query(
    "UPDATE slab_evidence_refreshes SET priority = $2 WHERE key = ANY($1::text[]) AND state = 'queued' AND priority < $2",
    [[...entries.keys()], priority],
  );
  return evidenceStatuses([...entries.keys()]);
}
export async function claimEvidenceJob(): Promise<EvidenceJob | null> {
  // An interrupted final attempt becomes terminal instead of sitting expired forever.
  await query(`UPDATE slab_evidence_refreshes SET state = 'failed', error_code = 'lease-expired', lease_id = NULL,
    lease_until = NULL, available_at = clock_timestamp() + interval '10 minutes', updated_at = clock_timestamp()
    WHERE state = 'running' AND lease_until <= clock_timestamp() AND attempts >= 3`);
  return queryOne(
    `UPDATE slab_evidence_refreshes SET state = 'running', attempts = attempts + 1,
    lease_id = $1, lease_until = clock_timestamp() + interval '90 seconds', updated_at = clock_timestamp()
    WHERE key = (SELECT key FROM slab_evidence_refreshes WHERE attempts < 3 AND
      ((state = 'queued' AND available_at <= clock_timestamp()) OR (state = 'running' AND lease_until <= clock_timestamp()))
      ORDER BY priority DESC, available_at, key FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING key, spec, run_id AS "runId", lease_id AS "leaseId", attempts`,
    [randomUUID()],
  );
}
export async function evidenceJobActive(job: EvidenceJob) {
  return !!(await queryOne(
    `SELECT 1 FROM slab_evidence_refreshes WHERE key = $1 AND run_id = $2 AND lease_id = $3
    AND state = 'running' AND lease_until > clock_timestamp()`,
    [job.key, job.runId, job.leaseId],
  ));
}
export async function completeEvidenceJob(
  job: EvidenceJob,
  payload: EvidencePayload,
  durationMs: number,
) {
  if (payload.kind !== job.spec.kind || evidenceKey(job.spec) !== job.key)
    throw new EvidenceRefreshError(
      "Evidence does not match its refresh request.",
    );
  const compact = compactEvidence(payload);
  validateEvidencePayload(job.spec, compact.payload);
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout = '15s'");
    const current = await db.query(
      `SELECT 1 FROM slab_evidence_refreshes WHERE key = $1 AND run_id = $2 AND lease_id = $3
      AND state = 'running' AND lease_until > clock_timestamp() FOR UPDATE`,
      [job.key, job.runId, job.leaseId],
    );
    if (!current.rowCount) return false;
    await recordSupplyScan(db, job, compact.payload);
    const supply =
      compact.payload.kind === "alt-supply" ||
      compact.payload.kind === "ebay-supply";
    const storedJson = supply
      ? JSON.stringify({
          ...compact.payload,
          data: { ...compact.payload.data, listings: undefined },
        })
      : compact.json;
    await db.query(
      `INSERT INTO slab_evidence_revisions(id, key, payload, fetched_at, byte_count, observation_count, supply_scan_id)
      VALUES ($1, $2, $3, clock_timestamp(), $4, $5, $6)`,
      [
        job.runId,
        job.key,
        storedJson,
        compact.bytes,
        compact.observations,
        supply ? job.runId : null,
      ],
    );
    await db.query(
      `UPDATE slab_evidence_refreshes SET state = 'idle', latest_revision = $2, fetched_at = clock_timestamp(),
      expires_at = clock_timestamp() + $4 * interval '1 second', available_at = clock_timestamp(), error_code = NULL,
      duration_ms = $3, lease_id = NULL, lease_until = NULL, updated_at = clock_timestamp() WHERE key = $1`,
      [
        job.key,
        job.runId,
        Math.min(120000, Math.max(0, Math.round(durationMs))),
        EVIDENCE_TTL_SECONDS[job.spec.kind],
      ],
    );
    return true;
  });
}
const ERROR_CODES = new Set([
  "not-configured",
  "reconnect-required",
  "busy",
  "rate-limited",
  "unavailable",
  "invalid-response",
  "cancelled",
  "lease-expired",
]);
export async function failEvidenceJob(
  job: EvidenceJob,
  code: string,
  retry: boolean,
) {
  const next =
    retry && job.attempts < 3
      ? "queued"
      : code === "cancelled"
        ? "cancelled"
        : "failed";
  return query(
    `UPDATE slab_evidence_refreshes SET state = $4, error_code = $5, lease_id = NULL, lease_until = NULL,
    available_at = clock_timestamp() + $6 * interval '1 second', updated_at = clock_timestamp()
    WHERE key = $1 AND run_id = $2 AND lease_id = $3 AND state = 'running' AND lease_until > clock_timestamp()`,
    [
      job.key,
      job.runId,
      job.leaseId,
      next,
      ERROR_CODES.has(code) ? code : "unavailable",
      next === "queued" ? 30 * job.attempts : 600,
    ],
  );
}
export async function cancelEvidenceRefresh(key: string, runId: string) {
  keysInput([key]);
  if (!/^[a-f0-9-]{36}$/.test(runId))
    throw new EvidenceRefreshError("Provide the current refresh run.");
  return query(
    `UPDATE slab_evidence_refreshes SET state = 'cancelled', error_code = 'cancelled', lease_id = NULL, lease_until = NULL,
    available_at = clock_timestamp() + interval '10 minutes', updated_at = clock_timestamp()
    WHERE key = $1 AND run_id = $2 AND state IN ('queued', 'running') RETURNING key`,
    [key, runId],
  );
}
export async function getEvidenceRevision(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new EvidenceRefreshError("Provide an evidence revision.");
  const row = await queryOne<{
    id: string;
    key: string;
    payload: EvidencePayload;
    fetchedAt: Date;
    bytes: number;
    observations: number;
    supplyScanId: string | null;
  }>(
    `SELECT id, key, payload, fetched_at AS "fetchedAt", byte_count AS bytes, observation_count AS observations, supply_scan_id AS "supplyScanId"
    FROM slab_evidence_revisions WHERE id = $1`,
    [id],
  );
  if (!row) return null;
  const { supplyScanId, ...record } = row;
  if (supplyScanId) {
    const scan = await getSupplyScan(supplyScanId);
    if (!scan) return null;
    if (scan.sourceKey !== record.key)
      throw new EvidenceRefreshError("Supply revision scope changed.");
    if (
      record.payload.kind !== "alt-supply" &&
      record.payload.kind !== "ebay-supply"
    )
      throw new EvidenceRefreshError("Invalid supply revision.");
    record.payload.data.listings = scan.listings;
  }
  return record;
}
// Recommendation creation must retain its evidence inside the same transaction as its references.
export async function retainEvidenceRevisions(
  ids: string[],
  executor?: Queryable,
) {
  if (ids.length > 200 || ids.some((id) => !/^[a-f0-9-]{36}$/.test(id)))
    throw new EvidenceRefreshError("Invalid evidence revision references.");
  const rows = await query(
    `UPDATE slab_evidence_revisions SET retained = true WHERE id = ANY($1::uuid[]) RETURNING id`,
    [ids],
    executor,
  );
  if (rows.length !== new Set(ids).size)
    throw new EvidenceRefreshError(
      "Evidence expired before it could be retained. Refresh and retry.",
    );
  return rows;
}
export async function cleanEvidenceCache() {
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout = '15s'");
    await cleanSupplyObservations(db);
    // Latest/retained revisions survive normal 30-day history compaction.
    const removed =
      await db.query(`DELETE FROM slab_evidence_revisions WHERE id IN (
      SELECT r.id FROM slab_evidence_revisions r WHERE NOT retained AND created_at < clock_timestamp() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM slab_evidence_refreshes j WHERE j.latest_revision = r.id)
      ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED) RETURNING id`);
    const old = await db.query<{
      key: string;
    }>(`SELECT j.key FROM slab_evidence_refreshes j WHERE state NOT IN ('queued', 'running')
      AND updated_at < clock_timestamp() - interval '90 days' AND NOT EXISTS (SELECT 1 FROM slab_evidence_revisions r WHERE r.key = j.key AND r.retained)
      ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED`);
    // Lock revisions, then recheck retention: a concurrent recommendation may have pinned one.
    const oldKeys = old.rows.map((row) => row.key);
    await db.query(
      "SELECT id FROM slab_evidence_revisions WHERE key = ANY($1::text[]) FOR UPDATE",
      [oldKeys],
    );
    const eligible = await db.query<{ key: string }>(
      "SELECT key FROM slab_evidence_refreshes j WHERE key = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM slab_evidence_revisions r WHERE r.key = j.key AND r.retained)",
      [oldKeys],
    );
    const keys = eligible.rows.map((row) => row.key);
    if (keys.length) {
      await db.query(
        "UPDATE slab_evidence_refreshes SET latest_revision = NULL WHERE key = ANY($1::text[])",
        [keys],
      );
      await db.query(
        "DELETE FROM slab_evidence_revisions WHERE key = ANY($1::text[])",
        [keys],
      );
      await db.query(
        "DELETE FROM slab_evidence_refreshes WHERE key = ANY($1::text[])",
        [keys],
      );
    }
    return { historyRemoved: removed.rowCount, keysRemoved: keys.length };
  });
}
