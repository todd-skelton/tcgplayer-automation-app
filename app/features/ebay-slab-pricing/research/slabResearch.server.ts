import { queryOne } from "~/core/db/database.server";
import { EvidenceRefreshError } from "../evidence/evidenceRefresh";
import { planSlabEvidence } from "../evidence/slabEvidenceRefresh.server";
import { evidenceStatuses } from "../evidence/evidenceRefreshStore.server";
import type { EvidenceWindow } from "../evidence/slabEvidence";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import { valuationGroupKey } from "../identity/slabIdentityService.server";
import { getSlabRecommendation } from "../valuation/slabRecommendations.server";

// Research uses a detached identity. It never confirms a certificate or changes its owned grade.
export function researchTarget(record: StoredSlabIdentity, grade: string) {
  const source = record.identity ?? record.candidate?.identity;
  if (!source)
    throw new EvidenceRefreshError(
      "Correct the card identity before researching it.",
    );
  if (grade === "owned") return { ...record, identity: source };
  const number = Number(grade);
  if (
    source.grading.grader !== "PSA" ||
    !/^(?:[1-9](?:\.5)?|10)$/.test(grade) ||
    number === 9.5
  )
    throw new EvidenceRefreshError(
      "Choose the owned grade or a supported PSA research grade.",
    );
  const identity = {
    ...source,
    grading: {
      grader: "PSA",
      encoding: grade,
      number,
      label: `PSA ${grade}`,
      qualifier: null,
      autograph: null,
    },
  };
  return {
    ...record,
    identity,
    valuationGroupKey: valuationGroupKey(identity),
  };
}
export async function loadResearchPlan(
  id: string,
  revision: number | null,
  grade: string,
  window: EvidenceWindow,
) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    throw new EvidenceRefreshError("Choose a saved slab identity.");
  const record = await queryOne<StoredSlabIdentity>(
    `SELECT id, grader, certificate_number AS "certificateNumber", candidate, identity, status,
    review_reasons AS "reviewReasons", valuation_group_key AS "valuationGroupKey", revision, decision_source AS "decisionSource",
    decision_note AS "decisionNote", updated_at AS "updatedAt" FROM slab_identities WHERE id=$1`,
    [id],
  );
  if (!record || (revision !== null && record.revision !== revision))
    throw new EvidenceRefreshError(
      "The slab identity changed. Reopen it before refreshing.",
    );
  const target = researchTarget(record, grade);
  const plan = planSlabEvidence(
    [
      {
        ...target,
        status: "confirmed",
        valuationGroupKey: valuationGroupKey(target.identity!),
      },
    ],
    window,
  );
  return { record, target, plan };
}
export async function loadSlabWorkspace(
  id: string,
  grade: string,
  window: EvidenceWindow,
) {
  const { record, target, plan } = await loadResearchPlan(
    id,
    null,
    grade,
    window,
  );
  const [statuses, latest] = await Promise.all([
    evidenceStatuses(plan.slabs[0].keys),
    queryOne<{ id: string }>(
      "SELECT id FROM slab_recommendations WHERE slab_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [id],
    ),
  ]);
  return {
    record,
    target,
    keys: plan.slabs[0].keys,
    statuses,
    recommendation: latest ? await getSlabRecommendation(latest.id) : null,
  };
}
export type SlabWorkspace = Awaited<ReturnType<typeof loadSlabWorkspace>>;
