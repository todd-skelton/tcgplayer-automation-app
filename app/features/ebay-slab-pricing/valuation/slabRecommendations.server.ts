import { createHash, randomUUID } from "node:crypto";
import { queryOne, withTransaction } from "~/core/db/database.server";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { EvidencePayload } from "../evidence/evidenceRefreshProvider.server";
import type { EvidenceSpec } from "../evidence/evidenceRefresh";
import { retainEvidenceRevisions } from "../evidence/evidenceRefreshStore.server";
import type { SaleReference } from "../screening/compEvents";
import type { CompDecision } from "../screening/screenComparables";
import { collectDirectComps } from "./directCompInputs";
import {
  estimateSlabMarket,
  proposeSlabAsk,
  validateValuationPolicy,
  validateSellerPriceContext,
  SlabValuationError,
  type SellerPriceContext,
  type ValuationPolicy,
} from "./slabValuation";

const uuid = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export type RecommendationInput = {
  slabId: string;
  identityRevision: number;
  revisionIds: string[];
  policy: ValuationPolicy;
  seller: SellerPriceContext;
};
type EvidenceRow = {
  id: string;
  payload: EvidencePayload;
  spec: EvidenceSpec;
  fetchedAt: Date;
  expiresAt: Date | null;
  latestRevision: string | null;
  state: string;
  bytes: number;
};
export async function calculateSlabRecommendation(
  input: RecommendationInput,
  asOf = new Date().toISOString(),
) {
  if (
    !input ||
    !uuid(input.slabId) ||
    !Number.isSafeInteger(input.identityRevision) ||
    input.identityRevision < 1 ||
    !Array.isArray(input.revisionIds) ||
    input.revisionIds.length > 20 ||
    input.revisionIds.some((id) => !uuid(id)) ||
    !Number.isFinite(Date.parse(asOf))
  )
    throw new SlabValuationError(
      "Choose a current slab identity and at most twenty evidence revisions.",
    );
  input = {
    ...input,
    policy: validateValuationPolicy(input.policy),
    seller: validateSellerPriceContext(input.seller, input.policy.currency),
  };
  const revisionIds = [...new Set(input.revisionIds)].sort();
  return withTransaction(async (db) => {
    await db.query("SET LOCAL statement_timeout = '15s'");
    const target = (
      await db.query<StoredSlabIdentity>(
        `SELECT id, grader, certificate_number AS "certificateNumber", identity, status, revision, valuation_group_key AS "valuationGroupKey" FROM slab_identities
      WHERE id = $1 AND revision = $2 AND status = 'confirmed' FOR SHARE`,
        [input.slabId, input.identityRevision],
      )
    ).rows[0];
    if (!target?.identity || !target.valuationGroupKey)
      throw new SlabValuationError(
        "The slab identity changed or is unconfirmed. Reload before calculating.",
      );
    const size = (
      await db.query<{ count: number; bytes: number }>(
        "SELECT count(*)::int AS count, COALESCE(sum(byte_count),0)::int AS bytes FROM slab_evidence_revisions WHERE id=ANY($1::uuid[])",
        [revisionIds],
      )
    ).rows[0];
    if (size.count !== revisionIds.length || size.bytes > 5 * 1024 * 1024)
      throw new SlabValuationError(
        "Evidence expired or the selection exceeds the calculation limit.",
      );
    const evidence = (
      await db.query<EvidenceRow>(
        `SELECT r.id, r.payload, r.fetched_at AS "fetchedAt", r.byte_count AS bytes,
      j.spec, j.expires_at AS "expiresAt", j.latest_revision AS "latestRevision", j.state
      FROM slab_evidence_revisions r JOIN slab_evidence_refreshes j ON j.key = r.key WHERE r.id = ANY($1::uuid[]) ORDER BY r.id FOR SHARE OF r`,
        [revisionIds],
      )
    ).rows;
    if (
      evidence.length !== revisionIds.length ||
      evidence.reduce((sum, row) => sum + row.bytes, 0) > 5 * 1024 * 1024
    )
      throw new SlabValuationError(
        "Evidence expired or the selection exceeds the calculation limit.",
      );
    const references: SaleReference[] = [];
    let capped = false,
      partial = false,
      stale = false;
    for (const row of evidence) {
      if (row.fetchedAt.getTime() > Date.parse(asOf))
        throw new SlabValuationError(
          "Evidence was captured after this calculation time.",
        );
      if (
        (row.spec.kind === "ebay-sales" || row.spec.kind === "ebay-supply") &&
        row.spec.groupKey !== target.valuationGroupKey
      )
        throw new SlabValuationError(
          "The eBay evidence belongs to another valuation identity.",
        );
      if (
        (row.spec.kind === "alt-sales" || row.spec.kind === "alt-supply") &&
        row.spec.assetId !== target.identity.providerAsset?.id
      )
        throw new SlabValuationError(
          "The Alt evidence belongs to another card asset.",
        );
      stale ||=
        !row.expiresAt ||
        row.expiresAt.getTime() <= Date.parse(asOf) ||
        row.latestRevision !== row.id ||
        row.state === "failed";
      const payload = row.payload;
      if (payload.kind === "alt-supply" || payload.kind === "ebay-supply")
        throw new SlabValuationError(
          "Supply observations cannot be used as sold comps.",
        );
      if (payload.kind === "alt-sale-detail") {
        if (payload.data) {
          if (
            payload.data.assetId &&
            target.identity.providerAsset?.id &&
            payload.data.assetId !== target.identity.providerAsset.id
          )
            throw new SlabValuationError(
              "The sale detail belongs to another card asset.",
            );
          references.push({
            revisionId: row.id,
            fetchedAt: row.fetchedAt.toISOString(),
            window: {
              from: new Date(
                Date.parse(asOf) - input.policy.maximumAgeDays * 86400000,
              )
                .toISOString()
                .slice(0, 10),
              to: asOf.slice(0, 10),
            },
            sale: payload.data,
          });
        }
      } else if (
        payload.kind === "alt-sales" ||
        payload.data.status === "sold"
      ) {
        capped ||= payload.data.coverage!.reason === "capped-per-grade";
        partial ||= !payload.data.coverage!.complete;
        for (const sale of payload.data.sales!)
          references.push({
            revisionId: row.id,
            fetchedAt: row.fetchedAt.toISOString(),
            window: payload.data.coverage!.requestedWindow,
            sale,
          });
      }
    }
    if (references.length > 2000)
      throw new SlabValuationError(
        "Narrow the evidence selection to at most 2,000 observations.",
      );
    const decisions = (
      await db.query<{ decision: CompDecision }>(
        "SELECT decision FROM slab_comp_decisions WHERE valuation_group_key = $1 AND revision_id = ANY($2::uuid[]) ORDER BY revision_id,event_key",
        [target.valuationGroupKey, revisionIds],
      )
    ).rows.map((row) => row.decision);
    const direct = collectDirectComps(
      references,
      target,
      decisions,
      input.policy,
    );
    const market = estimateSlabMarket({
      comps: direct.comps,
      quality: { ...direct.quality, stale, capped, partial },
      asOf,
      policy: input.policy,
    });
    const ask = proposeSlabAsk(market, input.seller, input.policy);
    const calculation = {
      identity: {
        slabId: target.id,
        revision: target.revision,
        valuationGroupKey: target.valuationGroupKey,
      },
      policyVersion: "slab-policy-v1",
      policy: input.policy,
      seller: input.seller,
      market,
      ask,
      dispositions: direct.dispositions,
      decisions,
      evidence: evidence.map((row) => ({
        revisionId: row.id,
        fetchedAt: row.fetchedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        spec: row.spec,
      })),
    };
    const json = JSON.stringify(calculation);
    if (Buffer.byteLength(json) > 512 * 1024)
      throw new SlabValuationError(
        "The calculation exceeds its storage limit. Narrow the evidence selection.",
      );
    const inputKey = createHash("sha256").update(json).digest("hex");
    const id = randomUUID();
    const saved = (
      await db.query<{ id: string }>(
        `INSERT INTO slab_recommendations(id,input_key,slab_id,identity_revision,valuation_group_key,calculation) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(input_key) DO UPDATE SET input_key = EXCLUDED.input_key RETURNING id`,
        [
          id,
          inputKey,
          target.id,
          target.revision,
          target.valuationGroupKey,
          json,
        ],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO slab_recommendation_evidence(recommendation_id,revision_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
      [saved.id, revisionIds],
    );
    await retainEvidenceRevisions(revisionIds, db);
    return { id: saved.id, calculation };
  });
}
export type SlabCalculation = Awaited<
  ReturnType<typeof calculateSlabRecommendation>
>["calculation"];
export type StoredSlabRecommendation = {
  id: string;
  calculation: SlabCalculation;
  current: boolean;
  override: {
    itemPrice: number;
    currency: string;
    note: string;
    reviewedAt: string;
  } | null;
};
export async function getSlabRecommendation(id: string) {
  if (!uuid(id)) throw new SlabValuationError("Choose a recommendation.");
  return queryOne<StoredSlabRecommendation>(
    `SELECT r.id, r.calculation, (i.revision = r.identity_revision AND i.valuation_group_key = r.valuation_group_key AND i.status = 'confirmed'
    AND r.calculation->'decisions' = COALESCE((SELECT jsonb_agg(d.decision ORDER BY d.revision_id,d.event_key) FROM slab_comp_decisions d
      WHERE d.valuation_group_key=r.valuation_group_key AND d.revision_id IN (SELECT revision_id FROM slab_recommendation_evidence WHERE recommendation_id=r.id)), '[]'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM slab_recommendation_evidence e JOIN slab_evidence_revisions v ON v.id=e.revision_id
      JOIN slab_evidence_refreshes j ON j.key=v.key WHERE e.recommendation_id=r.id AND (j.latest_revision IS DISTINCT FROM v.id OR j.expires_at <= clock_timestamp() OR j.expires_at IS NULL OR j.state='failed'))) AS current,
    CASE WHEN o.recommendation_id IS NULL THEN NULL ELSE jsonb_build_object('itemPrice',o.item_price,'currency',o.currency,'note',o.note,'reviewedAt',o.reviewed_at) END AS override
    FROM slab_recommendations r JOIN slab_identities i ON i.id=r.slab_id LEFT JOIN slab_price_overrides o ON o.recommendation_id=r.id WHERE r.id=$1`,
    [id],
  );
}
export async function overrideSlabPrice(input: {
  recommendationId: string;
  itemPrice: number;
  currency: string;
  note: string;
}) {
  if (
    !input ||
    !uuid(input.recommendationId) ||
    !Number.isFinite(input.itemPrice) ||
    input.itemPrice <= 0 ||
    input.itemPrice >= 1e9 ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    typeof input.note !== "string" ||
    !input.note.trim() ||
    input.note.length > 1000
  )
    throw new SlabValuationError(
      "Provide an explicit item price, currency and review reason.",
    );
  const saved = await queryOne(
    `INSERT INTO slab_price_overrides(recommendation_id,item_price,currency,note)
    SELECT r.id,$2,$3,$4 FROM slab_recommendations r JOIN slab_identities i ON i.id=r.slab_id
    WHERE r.id=$1 AND i.revision=r.identity_revision AND i.status='confirmed' AND i.valuation_group_key=r.valuation_group_key AND r.calculation->'policy'->>'currency'=$3
    ON CONFLICT(recommendation_id) DO UPDATE SET item_price=EXCLUDED.item_price,currency=EXCLUDED.currency,note=EXCLUDED.note,reviewed_at=clock_timestamp() RETURNING recommendation_id`,
    [
      input.recommendationId,
      input.itemPrice,
      input.currency,
      input.note.trim(),
    ],
  );
  if (!saved)
    throw new SlabValuationError(
      "The recommendation changed or uses another currency. Recalculate before overriding.",
    );
  return getSlabRecommendation(input.recommendationId);
}
