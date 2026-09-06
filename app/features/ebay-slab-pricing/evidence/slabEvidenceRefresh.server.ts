import { query } from "~/core/db/database.server";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import { buildResearchKeywords } from "./ebayResearchProvider.server";
import {
  evidenceWindow,
  EvidenceRefreshError,
  type EvidenceSpec,
} from "./evidenceRefresh";
import { evidenceKey } from "./evidenceRefreshProvider.server";
import { requestEvidence } from "./evidenceRefreshStore.server";
import type { EvidenceWindow } from "./slabEvidence";

export function planSlabEvidence(
  records: Pick<
    StoredSlabIdentity,
    "id" | "revision" | "status" | "identity" | "valuationGroupKey"
  >[],
  window: EvidenceWindow,
  includeSupply = false,
) {
  window = evidenceWindow(window);
  const requests = new Map<string, EvidenceSpec>();
  const slabs = records.map((record) => {
    const keys: string[] = [];
    if (
      record.status !== "confirmed" ||
      !record.identity ||
      !record.valuationGroupKey
    )
      return {
        slabId: record.id,
        revision: record.revision,
        keys,
        reason: "Confirm the slab identity first.",
      };
    const add = (spec: EvidenceSpec) => {
      const key = evidenceKey(spec);
      requests.set(key, spec);
      keys.push(key);
    };
    const assetId = record.identity.providerAsset?.id;
    if (assetId) {
      add({ kind: "alt-sales", assetId, window, limitPerGrade: 16 });
      if (includeSupply) add({ kind: "alt-supply", assetId });
    }
    const shared = {
      groupKey: record.valuationGroupKey,
      keywords: buildResearchKeywords(record.identity),
      window,
      offset: 0,
      limit: 50 as const,
      timezone: "America/Chicago",
    };
    add({ kind: "ebay-sales", ...shared });
    if (includeSupply) add({ kind: "ebay-supply", ...shared });
    return { slabId: record.id, revision: record.revision, keys, reason: null };
  });
  return { slabs, requests: [...requests.values()] };
}
export async function requestSlabEvidence(
  ids: string[],
  window: EvidenceWindow,
  options: { includeSupply?: boolean; force?: boolean } = {},
) {
  if (
    !Array.isArray(ids) ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
  )
    throw new EvidenceRefreshError("Select at most fifty slab identities.");
  const records = await query<StoredSlabIdentity>(
    `SELECT id, identity, status, revision, valuation_group_key AS "valuationGroupKey" FROM slab_identities WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  if (records.length !== new Set(ids).size)
    throw new EvidenceRefreshError(
      "One or more slab identities no longer exist.",
    );
  const plan = planSlabEvidence(
    records,
    window,
    options.includeSupply === true,
  );
  const started = performance.now();
  const statuses = await requestEvidence(plan.requests, {
    force: options.force,
    priority: 200,
  });
  return {
    slabs: plan.slabs,
    statuses,
    metrics: {
      slabs: records.length,
      uniqueRequests: plan.requests.length,
      fresh: statuses.filter((row) => !row.stale && row.state === "idle")
        .length,
      queued: statuses.filter((row) => row.state === "queued").length,
      cacheMs: Math.round(performance.now() - started),
    },
  };
}
