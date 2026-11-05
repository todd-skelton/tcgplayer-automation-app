import { EvidenceRefreshError } from "../evidence/evidenceRefresh";
import { getEvidenceRevision } from "../evidence/evidenceRefreshStore.server";
import type { EvidenceWindow, SaleEvidence } from "../evidence/slabEvidence";
import { loadResearchPlan } from "../research/slabResearch.server";
import { getCompDecisions } from "./compDecisions.server";
import { screenComparableSale, type CompDecision } from "./screenComparables";

const PAGE = 50;

// A page of a saved sales revision, each sale screened against the researched identity with its
// saved decision: what the comp review shows. Read-only; it never calls a provider.
export async function loadCompReview(input: {
  id: string;
  grade: string;
  window: EvidenceWindow;
  revision: string;
  offset: number;
}) {
  if (
    !Number.isInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > 2000
  )
    throw new EvidenceRefreshError("Invalid evidence page.");
  const { record, target } = await loadResearchPlan(
    input.id,
    null,
    input.grade,
    input.window,
  );
  const saved = await getEvidenceRevision(input.revision);
  if (!saved)
    throw new EvidenceRefreshError("Evidence revision is no longer available.");
  const payload = saved.payload;
  const all: SaleEvidence[] =
    payload.kind === "alt-sale-detail"
      ? payload.data
        ? [payload.data]
        : []
      : payload.kind === "alt-sales" || payload.kind === "ebay-sales"
        ? (payload.data.sales ?? [])
        : [];
  const coverage =
    payload.kind === "alt-sales" || payload.kind === "ebay-sales"
      ? payload.data.coverage
      : null;
  const canReview =
    input.grade === "owned" &&
    record.status === "confirmed" &&
    !!target.valuationGroupKey;
  const decisions: CompDecision[] = canReview
    ? await getCompDecisions(target.valuationGroupKey!, [saved.id])
    : [];
  const sales = all.slice(input.offset, input.offset + PAGE);
  const rows = sales.map((sale) => {
    const decision = decisions.find(
      (d) =>
        d.provider === sale.provider &&
        d.providerId === sale.providerId &&
        d.date === sale.date,
    );
    const screened = screenComparableSale(
      {
        revisionId: saved.id,
        fetchedAt: saved.fetchedAt.toISOString(),
        window: coverage?.requestedWindow ?? {
          from: sale.date ?? "",
          to: sale.date ?? "",
        },
        sale,
      },
      target,
      { currency: "USD", decision },
    );
    return {
      sale,
      status: screened.status,
      reasons: screened.reasons.map((r) => r.code),
      decision: decision ?? null,
    };
  });
  return {
    revisionId: saved.id,
    kind: payload.kind,
    identityRevision: record.revision,
    canReview,
    coverage,
    activeListings:
      payload.kind === "ebay-sales" && payload.data.status !== "sold",
    nextSourcePage:
      payload.kind === "ebay-sales" && payload.data.page?.nextOffset != null,
    page: {
      offset: input.offset,
      total: all.length,
      nextOffset:
        input.offset + PAGE < all.length ? input.offset + PAGE : null,
    },
    rows,
  };
}
