import type { StoredSlabIdentity } from "../identity/slabIdentity";
import {
  reconcileSaleEvents,
  type SaleReference,
} from "../screening/compEvents";
import {
  screenComparableSale,
  type CompDecision,
} from "../screening/screenComparables";
import type {
  DirectComp,
  EvidenceQuality,
  ValuationPolicy,
} from "./slabValuation";

export type CompDisposition = {
  key: string;
  status: "needs-review" | "rejected";
  reasons: string[];
  references: DirectComp["references"];
};
export function collectDirectComps(
  references: SaleReference[],
  target: StoredSlabIdentity,
  decisions: CompDecision[],
  policy: ValuationPolicy,
) {
  const decisionIndex = new Map(
    decisions.map((decision) => [
      JSON.stringify([
        decision.revisionId,
        decision.provider,
        decision.providerId,
        decision.date,
      ]),
      decision,
    ]),
  );
  const comps: DirectComp[] = [],
    dispositions: CompDisposition[] = [],
    eventWarnings = new Set<string>();
  const activeReferences = references.filter((reference) => {
    const decision = decisionIndex.get(
      JSON.stringify([
        reference.revisionId,
        reference.sale.provider,
        reference.sale.providerId,
        reference.sale.date,
      ]),
    );
    if (
      decision?.decision !== "exclude" ||
      decision.valuationGroupKey !== target.valuationGroupKey ||
      !decision.note.trim()
    )
      return true;
    dispositions.push({
      key: `excluded:${reference.revisionId}:${reference.sale.provider}:${reference.sale.providerId}:${reference.sale.date}`,
      status: "rejected",
      reasons: ["excluded-by-review"],
      references: [
        {
          revisionId: reference.revisionId,
          provider: reference.sale.provider,
          providerId: reference.sale.providerId,
          date: reference.sale.date,
        },
      ],
    });
    return false;
  });
  for (const event of reconcileSaleEvents(activeReferences)) {
    const screened = event.references.map((reference) =>
      screenComparableSale(reference, target, {
        currency: policy.currency,
        decision: decisionIndex.get(
          JSON.stringify([
            reference.revisionId,
            reference.sale.provider,
            reference.sale.providerId,
            reference.sale.date,
          ]),
        ),
      }),
    );
    const accepted = screened
      .filter((row) => row.status === "accepted")
      .sort(
        (a, b) =>
          Number(b.reference.sale.provider === "ebayResearch") -
            Number(a.reference.sale.provider === "ebayResearch") ||
          b.reference.fetchedAt.localeCompare(a.reference.fetchedAt),
      );
    const refIds = event.references.map((ref) => ({
      revisionId: ref.revisionId,
      provider: ref.sale.provider,
      providerId: ref.sale.providerId,
      date: ref.sale.date,
    }));
    const selected = accepted.find((row) =>
      policy.basis === "item-only"
        ? row.price.itemOnly
        : row.price.itemAndShipping,
    );
    const blockedEvent = event.reasons.some((reason) =>
      [
        "possible-duplicate-event-requires-review",
        "aggregate-may-overlap-individual-sales",
        "source-price-disagreement",
      ].includes(reason),
    );
    const contradictory = screened.some((row) => row.status === "rejected");
    if (selected && !blockedEvent && !contradictory) {
      const price =
        policy.basis === "item-only"
          ? selected.price.itemOnly!
          : selected.price.itemAndShipping!;
      // Keep the price reference first, with all corroborating sources after it.
      const primary = refIds.find(
        (ref) =>
          ref.revisionId === selected.reference.revisionId &&
          ref.provider === selected.reference.sale.provider &&
          ref.providerId === selected.reference.sale.providerId,
      )!;
      comps.push({
        key: event.key,
        date: selected.reference.sale.date!,
        amount: price.amount,
        currency: price.currency!,
        kind: event.kind,
        references: [primary, ...refIds.filter((ref) => ref !== primary)],
      });
      event.reasons.forEach((reason) => eventWarnings.add(reason));
    } else {
      const reasons = new Set([
        ...event.reasons,
        ...screened.flatMap((row) => row.reasons.map((reason) => reason.code)),
      ]);
      if (accepted.length && !selected)
        reasons.add("requested-price-basis-unresolved");
      dispositions.push({
        key: event.key,
        status:
          contradictory && screened.every((row) => row.status === "rejected")
            ? "rejected"
            : "needs-review",
        reasons: [...reasons].sort(),
        references: refIds,
      });
    }
  }
  return {
    comps,
    dispositions,
    decisions,
    quality: {
      uncertain: dispositions.filter((row) => row.status === "needs-review")
        .length,
      rejected: dispositions.filter((row) => row.status === "rejected").length,
      eventWarnings: [...eventWarnings].sort(),
    } satisfies Pick<
      EvidenceQuality,
      "uncertain" | "rejected" | "eventWarnings"
    >,
  };
}
