import { createHash } from "node:crypto";
import { queryOne, type Queryable } from "~/core/db/database.server";
import type { EvidenceJob } from "../evidence/evidenceRefreshStore.server";
import type { EvidencePayload } from "../evidence/evidenceRefreshProvider.server";
import type { SupplyEvidence } from "../evidence/slabEvidence";
import { supplyListingKey, type SupplyScan } from "./supplyContext";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, canonical(value)]),
        )
      : value;
export function supplyVersion(listing: SupplyEvidence) {
  const payload = {
    ...listing,
    title: listing.title ?? null,
    extendedTitle: listing.extendedTitle ?? null,
    items: [...listing.items].sort((a, b) =>
      JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))),
    ),
  };
  const json = JSON.stringify(canonical(payload));
  return { hash: hash(json), listing_key: supplyListingKey(listing), payload };
}
// Called inside the evidence-completion transaction: a cancelled/stale lease cannot append history.
export async function recordSupplyScan(
  db: Queryable,
  job: EvidenceJob,
  payload: EvidencePayload,
) {
  if (payload.kind !== "alt-supply" && payload.kind !== "ebay-supply") return;
  if (job.spec.kind !== payload.kind)
    throw new Error("Supply does not match its source request.");
  const versions = new Map<string, ReturnType<typeof supplyVersion>>();
  if (payload.data.listings.length > 2000)
    throw new Error("Supply exceeds the observation limit.");
  for (const listing of payload.data.listings) {
    const version = supplyVersion(listing),
      previous = versions.get(version.listing_key);
    if (previous && previous.hash !== version.hash)
      throw new Error(
        "A supply scan contains contradictory copies of a listing.",
      );
    versions.set(version.listing_key, version);
  }
  const rows = [...versions.values()].map((row, position) => ({
    ...row,
    position,
  }));
  const contentHash = hash(
    JSON.stringify(rows.map((row) => [row.listing_key, row.hash])),
  );
  const inserted = await db.query(
    `INSERT INTO slab_supply_scans(id,source_key,provider,valuation_group_key,asset_id,captured_at,complete,reported_count,stored_count,content_hash)
    VALUES($1,$2,$3,$4,$5,$6,false,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [
      job.runId,
      job.key,
      payload.kind === "alt-supply" ? "alt" : "ebayResearch",
      job.spec.kind === "ebay-supply" ? job.spec.groupKey : null,
      job.spec.kind === "alt-supply" ? job.spec.assetId : null,
      payload.data.asOf,
      payload.data.listings.length,
      rows.length,
      contentHash,
    ],
  );
  if (!inserted.rowCount) {
    const existing = await db.query<{
      content_hash: string;
      captured_at: Date;
      source_key: string;
      reported_count: number;
    }>(
      "SELECT content_hash,captured_at,source_key,reported_count FROM slab_supply_scans WHERE id=$1",
      [job.runId],
    );
    const previous = existing.rows[0];
    if (
      previous?.content_hash !== contentHash ||
      previous.source_key !== job.key ||
      previous.captured_at.getTime() !== Date.parse(payload.data.asOf) ||
      previous.reported_count !== payload.data.listings.length
    )
      throw new Error("Supply revision content changed.");
    return;
  }
  const previous = await db.query<{ id: string; content_hash: string }>(
    "SELECT id,content_hash FROM slab_supply_scans WHERE source_key=$1 AND id<>$2 ORDER BY captured_at DESC,id DESC LIMIT 1 FOR SHARE",
    [job.key, job.runId],
  );
  if (previous.rows[0]?.content_hash === contentHash) {
    const copied = await db.query(
      "INSERT INTO slab_supply_observations(scan_id,listing_key,version_hash,position) SELECT $1,listing_key,version_hash,position FROM slab_supply_observations WHERE scan_id=$2",
      [job.runId, previous.rows[0].id],
    );
    if (copied.rowCount !== rows.length)
      throw new Error("Supply references changed during capture.");
  } else {
    // The no-op conflict update holds a row lock through membership insertion, excluding retention races.
    await db.query(
      `INSERT INTO slab_supply_versions(hash,listing_key,payload) SELECT x.hash,x.listing_key,x.payload
    FROM jsonb_to_recordset($1::jsonb) AS x(hash text,listing_key text,payload jsonb) ORDER BY x.listing_key,x.hash
    ON CONFLICT(hash) DO UPDATE SET hash=EXCLUDED.hash`,
      [JSON.stringify(rows)],
    );
    await db.query(
      `INSERT INTO slab_supply_observations(scan_id,listing_key,version_hash,position)
    SELECT $1,x.listing_key,x.hash,x.position FROM jsonb_to_recordset($2::jsonb) AS x(hash text,listing_key text,position smallint)`,
      [job.runId, JSON.stringify(rows)],
    );
  }
  const old = await db.query<{ id: string }>(
    `SELECT id FROM slab_supply_scans WHERE id IN (SELECT id FROM slab_supply_scans WHERE source_key=$1 ORDER BY captured_at DESC,id DESC OFFSET 200 LIMIT 20) AND id<>$2 FOR UPDATE SKIP LOCKED`,
    [job.key, job.runId],
  );
  const ids = old.rows.map((row) => row.id);
  await db.query(
    `DELETE FROM slab_evidence_revisions r WHERE r.supply_scan_id=ANY($1::uuid[]) AND NOT r.retained AND NOT EXISTS(SELECT 1 FROM slab_evidence_refreshes j WHERE j.latest_revision=r.id)`,
    [ids],
  );
  await db.query(
    `DELETE FROM slab_supply_scans s WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM slab_evidence_revisions r WHERE r.supply_scan_id=s.id)`,
    [ids],
  );
}
export async function getSupplyScan(id: string): Promise<SupplyScan | null> {
  const scan = await queryOne<{
    id: string;
    sourceKey: string;
    capturedAt: Date;
    complete: boolean;
    reportedCount: number;
    listings: SupplyEvidence[];
  }>(
    `SELECT s.id,s.source_key AS "sourceKey",s.captured_at AS "capturedAt",s.complete,s.reported_count AS "reportedCount",
    COALESCE((SELECT jsonb_agg(v.payload ORDER BY o.position) FROM slab_supply_observations o JOIN slab_supply_versions v ON v.hash=o.version_hash WHERE o.scan_id=s.id),'[]'::jsonb) AS listings FROM slab_supply_scans s WHERE s.id=$1`,
    [id],
  );
  if (!scan) return null;
  return { ...scan, capturedAt: scan.capturedAt.toISOString() };
}
export async function previousSupplyScan(sourceKey: string, before: string) {
  const row = await queryOne<{ id: string }>(
    "SELECT id FROM slab_supply_scans WHERE source_key=$1 AND captured_at<$2 ORDER BY captured_at DESC,id DESC LIMIT 1",
    [sourceKey, before],
  );
  return row ? getSupplyScan(row.id) : null;
}
export async function cleanSupplyObservations(db: Queryable) {
  await db.query(
    `DELETE FROM slab_supply_scans WHERE id IN (SELECT s.id FROM slab_supply_scans s WHERE captured_at<clock_timestamp()-interval '180 days' AND NOT EXISTS(SELECT 1 FROM slab_evidence_revisions r WHERE r.supply_scan_id=s.id) ORDER BY captured_at LIMIT 200 FOR UPDATE SKIP LOCKED)`,
  );
  await db.query(
    `DELETE FROM slab_supply_versions WHERE hash IN (SELECT v.hash FROM slab_supply_versions v WHERE NOT EXISTS(SELECT 1 FROM slab_supply_observations o WHERE o.version_hash=v.hash) ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED)`,
  );
}
