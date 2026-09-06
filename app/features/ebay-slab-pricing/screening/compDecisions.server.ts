import { query, withTransaction } from "~/core/db/database.server";
import { isSlabProvider } from "../connections/providerConnection";
import type { EvidencePayload } from "../evidence/evidenceRefreshProvider.server";
import { retainEvidenceRevisions } from "../evidence/evidenceRefreshStore.server";
import type { CompDecision } from "./screenComparables";
import type { Money, SaleEvidence } from "../evidence/slabEvidence";

export class CompReviewError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid-input" | "conflict" = "invalid-input",
  ) {
    super(message);
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function compDecisionKey(
  sale: Pick<SaleEvidence, "provider" | "providerId" | "date">,
) {
  return JSON.stringify([sale.provider, sale.providerId, sale.date]);
}
export async function saveCompDecision(input: {
  slabId: string;
  identityRevision: number;
  revisionId: string;
  provider: string;
  providerId: string;
  date: string | null;
  decision: "accept" | "exclude";
  note: string;
  itemPrice?: Money | null;
}) {
  if (
    !uuid(input.slabId) ||
    !Number.isSafeInteger(input.identityRevision) ||
    input.identityRevision < 1 ||
    !uuid(input.revisionId) ||
    !isSlabProvider(input.provider) ||
    typeof input.providerId !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(input.providerId) ||
    !["accept", "exclude"].includes(input.decision) ||
    typeof input.note !== "string" ||
    !input.note.trim() ||
    input.note.length > 1000 ||
    (input.date !== null &&
      (typeof input.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.date)))
  )
    throw new CompReviewError(
      "Choose a displayed sale, a review decision and a short reason.",
    );
  const itemPrice = input.itemPrice ?? null;
  if (
    itemPrice &&
    (typeof itemPrice.amount !== "number" ||
      !Number.isFinite(itemPrice.amount) ||
      itemPrice.amount <= 0 ||
      itemPrice.amount >= 1e9 ||
      typeof itemPrice.currency !== "string" ||
      !/^[A-Z]{3}$/.test(itemPrice.currency))
  )
    throw new CompReviewError(
      "A reviewed item price needs a positive amount and currency.",
    );
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout = '10s'");
    const target = (
      await db.query<{ valuation_group_key: string }>(
        "SELECT valuation_group_key FROM slab_identities WHERE id = $1 AND revision = $2 AND status = 'confirmed' FOR SHARE",
        [input.slabId, input.identityRevision],
      )
    ).rows[0];
    if (!target?.valuation_group_key)
      throw new CompReviewError(
        "Reload and confirm the slab identity before reviewing comps.",
        "conflict",
      );
    const revision = (
      await db.query<{ payload: EvidencePayload }>(
        "SELECT payload FROM slab_evidence_revisions WHERE id = $1 FOR UPDATE",
        [input.revisionId],
      )
    ).rows[0];
    const payload = revision?.payload;
    const rows =
      payload?.kind === "alt-sale-detail"
        ? payload.data
          ? [payload.data]
          : []
        : payload?.kind === "alt-sales" ||
            (payload?.kind === "ebay-sales" && payload.data.status === "sold")
          ? (payload.data.sales ?? [])
          : [];
    const matches = rows.filter(
      (row) =>
        row.provider === input.provider &&
        row.providerId === input.providerId &&
        row.date === input.date,
    );
    if (matches.length !== 1)
      throw new CompReviewError(
        "The evidence revision does not contain this exact sale.",
      );
    const decision: CompDecision = {
      revisionId: input.revisionId,
      provider: input.provider,
      providerId: input.providerId,
      date: input.date,
      valuationGroupKey: target.valuation_group_key,
      decision: input.decision,
      note: input.note.trim(),
      itemPrice,
    };
    await db.query(
      `INSERT INTO slab_comp_decisions(revision_id, valuation_group_key, event_key, decision) VALUES ($1,$2,$3,$4)
      ON CONFLICT (revision_id, valuation_group_key, event_key) DO UPDATE SET decision = EXCLUDED.decision, updated_at = clock_timestamp()`,
      [
        input.revisionId,
        target.valuation_group_key,
        compDecisionKey(matches[0]),
        JSON.stringify(decision),
      ],
    );
    await retainEvidenceRevisions([input.revisionId], db);
    return decision;
  });
}
export async function getCompDecisions(
  groupKey: string,
  revisionIds: string[],
) {
  if (
    !/^[a-f0-9]{64}$/.test(groupKey) ||
    !Array.isArray(revisionIds) ||
    revisionIds.length > 50 ||
    revisionIds.some((id) => !uuid(id))
  )
    throw new CompReviewError(
      "Choose a valuation group and at most fifty evidence revisions.",
    );
  const rows = await query<{ decision: CompDecision }>(
    "SELECT decision FROM slab_comp_decisions WHERE valuation_group_key = $1 AND revision_id = ANY($2::uuid[]) ORDER BY revision_id, event_key LIMIT 2001",
    [groupKey, revisionIds],
  );
  if (rows.length > 2000)
    throw new CompReviewError(
      "Narrow the evidence selection before loading reviews.",
    );
  return rows.map((row) => row.decision);
}
