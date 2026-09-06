import type {
  EvidenceWindow,
  Money,
  SaleEvidence,
} from "../evidence/slabEvidence";
import { gradeLabelKey, titleFacts } from "./compIdentity";

export type SaleReference = {
  revisionId: string;
  fetchedAt: string;
  window: EvidenceWindow;
  sale: SaleEvidence;
};
export type CompEvent = {
  key: string;
  references: SaleReference[];
  representative: SaleReference;
  reportedPrice: Money | null;
  kind: "single-sale" | "listing-average";
  reasons: string[];
};
const sourceKey = (ref: SaleReference) =>
  JSON.stringify([
    ref.sale.provider,
    ref.sale.providerId,
    ref.sale.kind,
    ref.sale.provider === "alt" ? null : ref.sale.date,
    ref.sale.kind === "listing-average" && ref.sale.quantity !== 1
      ? [ref.window.from, ref.window.to]
      : null,
  ]);
function grade(ref: SaleReference) {
  const facts = titleFacts(ref.sale.title ?? "");
  const title = facts.grades.length === 1 ? facts.grades[0] : null;
  const grader =
    ref.sale.grading.grader === "UNKNOWN"
      ? title?.grader
      : ref.sale.grading.grader;
  const number = ref.sale.grading.number ?? title?.number;
  const label = grader
    ? gradeLabelKey(
        grader,
        ref.sale.grading.label ?? title?.label ?? null,
        number ?? null,
      )
    : null;
  return grader && number != null && label
    ? `${grader}:${number}:${label}:${ref.sale.grading.qualifier ?? title?.qualifier ?? ""}`
    : null;
}
function event(key: string, references: SaleReference[]): CompEvent {
  const newest = [...references].sort(
    (a, b) =>
      b.fetchedAt.localeCompare(a.fetchedAt) ||
      a.revisionId.localeCompare(b.revisionId),
  );
  // For a matched eBay sale, prefer eBay's native reported item amount to an undated converted field.
  const representative =
    newest.find(
      (ref) => ref.sale.provider === "ebayResearch" && ref.sale.price?.currency,
    ) ??
    newest.find((ref) => ref.sale.price?.currency) ??
    newest[0];
  const reasons = new Set<string>();
  const knownPrices = references.flatMap((ref) =>
    ref.sale.price?.currency
      ? [`${ref.sale.price.currency}:${ref.sale.price.amount}`]
      : [],
  );
  if (new Set(knownPrices).size > 1) reasons.add("source-price-disagreement");
  const reportedPrice = representative.sale.price;
  for (const ref of references) {
    if (
      reportedPrice?.currency &&
      ref.sale.convertedPrice?.currency === reportedPrice.currency &&
      ref.sale.convertedPrice.amount !== reportedPrice.amount
    )
      reasons.add("provider-conversion-disagrees-with-reported-price");
  }
  const kind = references.some(
    (ref) => ref.sale.kind === "transaction" || ref.sale.quantity === 1,
  )
    ? "single-sale"
    : "listing-average";
  if (kind === "listing-average")
    reasons.add("aggregate-is-not-an-independent-transaction");
  return {
    key,
    references: newest,
    representative,
    reportedPrice,
    kind,
    reasons: [...reasons],
  };
}
export function reconcileSaleEvents(references: SaleReference[]): CompEvent[] {
  const copies = new Map<string, Map<string, SaleReference>>();
  for (const ref of references) {
    const key = sourceKey(ref),
      rows = copies.get(key) ?? new Map<string, SaleReference>();
    rows.set(JSON.stringify([ref.revisionId, ref.sale]), ref);
    copies.set(key, rows);
  }
  const events = [...copies].map(([key, rows]) =>
    event(key, [...rows.values()]),
  );
  const buckets = new Map<string, CompEvent[]>();
  for (const entry of events) {
    const sale = entry.representative.sale;
    if (sale.sourceItemId && sale.date && entry.kind === "single-sale") {
      const key = JSON.stringify([sale.sourceItemId, sale.date]);
      const bucket = buckets.get(key) ?? [];
      bucket.push(entry);
      buckets.set(key, bucket);
    }
  }
  const replaced = new Set<CompEvent>(),
    joined: CompEvent[] = [];
  for (const [key, bucket] of buckets) {
    const alt = bucket.filter(
      (entry) => entry.representative.sale.provider === "alt",
    );
    const ebay = bucket.filter(
      (entry) => entry.representative.sale.provider === "ebayResearch",
    );
    if (
      alt.length === 1 &&
      ebay.length === 1 &&
      grade(alt[0].representative) &&
      grade(alt[0].representative) === grade(ebay[0].representative) &&
      (!alt[0].representative.sale.certificateNumber ||
        !ebay[0].representative.sale.certificateNumber ||
        alt[0].representative.sale.certificateNumber ===
          ebay[0].representative.sale.certificateNumber)
    ) {
      replaced.add(alt[0]);
      replaced.add(ebay[0]);
      joined.push(
        event(`ebay-event:${key}`, [
          ...alt[0].references,
          ...ebay[0].references,
        ]),
      );
    } else if (alt.length && ebay.length)
      bucket.forEach((entry) =>
        entry.reasons.push("possible-duplicate-event-requires-review"),
      );
  }
  const result = [...events.filter((entry) => !replaced.has(entry)), ...joined];
  const individualItems = new Set(
    result
      .filter((entry) => entry.kind === "single-sale")
      .map((entry) => entry.representative.sale.sourceItemId)
      .filter(Boolean),
  );
  for (const entry of result)
    if (
      entry.kind === "listing-average" &&
      individualItems.has(entry.representative.sale.sourceItemId)
    )
      entry.reasons.push("aggregate-may-overlap-individual-sales");
  return result.sort((a, b) => a.key.localeCompare(b.key));
}
