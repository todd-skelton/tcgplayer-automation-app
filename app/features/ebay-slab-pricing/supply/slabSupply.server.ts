import { query } from "~/core/db/database.server";
import { EvidenceRefreshError } from "../evidence/evidenceRefresh";
import { evidenceKey } from "../evidence/evidenceRefreshProvider.server";
import {
  evidenceStatuses,
  getEvidenceRevision,
  requestEvidence,
} from "../evidence/evidenceRefreshStore.server";
import { ensureEvidenceWorker } from "../evidence/evidenceRefreshWorker.server";
import type { EvidenceWindow } from "../evidence/slabEvidence";
import { sellerAccount } from "../inventory/slabInventory";
import { loadResearchPlan } from "../research/slabResearch.server";
import {
  compareSupplyScans,
  describeSupply,
  type SupplyScan,
} from "./supplyContext";
import { previousSupplyScan } from "./supplyObservations.server";

export type SupplyContextInput = {
  slabId: string;
  grade: string;
  window: EvidenceWindow;
  seller: string;
  key?: string;
  offset?: number;
};
export async function requestSlabSupply(
  input: SupplyContextInput & { identityRevision: number },
) {
  if (
    !Number.isSafeInteger(input.identityRevision) ||
    input.identityRevision < 1
  )
    throw new EvidenceRefreshError("Provide the current identity revision.");
  const { plan } = await loadResearchPlan(
    input.slabId,
    input.identityRevision,
    input.grade,
    input.window,
    true,
  );
  const statuses = await requestEvidence(
    plan.requests.filter(
      (s) => s.kind === "alt-supply" || s.kind === "ebay-supply",
    ),
    { force: true, priority: 200 },
  );
  ensureEvidenceWorker();
  return { statuses };
}
export async function loadSlabSupply(input: SupplyContextInput) {
  const seller = sellerAccount(input.seller),
    offset = input.offset ?? 0;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1950 ||
    offset % 50 !== 0
  )
    throw new EvidenceRefreshError("Choose a bounded supply page.");
  const { target, plan } = await loadResearchPlan(
    input.slabId,
    null,
    input.grade,
    input.window,
    true,
  );
  const keys = plan.requests
    .filter((s) => s.kind === "alt-supply" || s.kind === "ebay-supply")
    .map(evidenceKey);
  const statuses = await evidenceStatuses([
    ...new Set([...keys, ...(input.key ? [input.key] : [])]),
  ]);
  if (input.key && !keys.includes(input.key)) {
    const page = statuses.find((s) => s.key === input.key);
    if (
      !page ||
      page.spec.kind !== "ebay-supply" ||
      !keys.includes(evidenceKey({ ...page.spec, offset: 0 }))
    )
      throw new EvidenceRefreshError(
        "This supply page belongs to another research context.",
      );
  }
  if (statuses.some((s) => s.state === "queued" || s.state === "running"))
    ensureEvidenceWorker();
  const selected =
    statuses.find((s) => s.key === input.key) ??
    statuses.find((s) => s.spec.kind === "ebay-supply" && s.latestRevision) ??
    statuses.find((s) => s.latestRevision) ??
    statuses[0];
  const owned = await query<{ itemId: string }>(
    'SELECT DISTINCT item_id AS "itemId" FROM slab_inventory WHERE seller=$1 LIMIT 10001',
    [seller],
  );
  if (owned.length > 10000)
    throw new EvidenceRefreshError(
      "Supply context supports at most 10,000 known seller item IDs.",
    );
  const shared = {
    identityRevision: target.revision,
    statuses,
    keys,
    selectedKey: selected?.key ?? null,
    knownOwnListings: owned.length,
    ownExclusionScope: "known-imported-inventory" as const,
    outcomesAvailable: false as const,
    saleProbability: null,
    expectedDaysToSell: null,
  };
  if (!selected?.latestRevision)
    return {
      ...shared,
      context: null,
      changes: null,
      page: null,
      sourceHasMorePages: false,
    };
  const cached = await getEvidenceRevision(selected.latestRevision);
  if (
    !cached ||
    (cached.payload.kind !== "alt-supply" &&
      cached.payload.kind !== "ebay-supply")
  )
    return {
      ...shared,
      context: null,
      changes: null,
      page: null,
      sourceHasMorePages: false,
    };
  const scan: SupplyScan = {
    id: cached.id,
    sourceKey: selected.key,
    capturedAt: cached.payload.data.asOf,
    complete: false,
    reportedCount: cached.payload.data.listings.length,
    listings: cached.payload.data.listings,
  };
  const previous = await previousSupplyScan(selected.key, scan.capturedAt);
  const context = describeSupply(
    scan,
    target,
    new Set(owned.map((r) => r.itemId)),
    new Date().toISOString(),
    selected.stale,
  );
  const pageOffset = Math.min(
    offset,
    Math.max(0, Math.floor((scan.listings.length - 1) / 50) * 50),
  );
  return {
    ...shared,
    context: {
      ...context,
      rows: context.rows.slice(pageOffset, pageOffset + 50),
    },
    changes: previous ? compareSupplyScans(previous, scan) : null,
    page: {
      offset: pageOffset,
      total: scan.listings.length,
      nextOffset:
        pageOffset + 50 < scan.listings.length ? pageOffset + 50 : null,
    },
    sourceHasMorePages:
      cached.payload.kind === "ebay-supply" &&
      cached.payload.data.page.nextOffset !== null,
  };
}
export type SlabSupplyContext = Awaited<ReturnType<typeof loadSlabSupply>>;
