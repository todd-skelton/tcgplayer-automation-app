import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { Money, SupplyEvidence } from "../evidence/slabEvidence";
import { compareCompIdentity, type CompReason } from "./compIdentity";
import { normalizeSalePrice, type DatedConversion } from "./salePrice";
import type { SaleReference } from "./compEvents";

export type CompDecision = {
  revisionId: string;
  provider: string;
  providerId: string;
  date: string | null;
  valuationGroupKey: string;
  decision: "accept" | "exclude";
  note: string;
  itemPrice: Money | null;
};
export type CompScreening = {
  status: "accepted" | "needs-review" | "rejected";
  reference: SaleReference;
  reasons: CompReason[];
  price: ReturnType<typeof normalizeSalePrice>;
  decision: CompDecision | null;
};
export function screenComparableSale(
  reference: SaleReference,
  target: StoredSlabIdentity,
  options: {
    currency: string;
    conversion?: DatedConversion;
    decision?: CompDecision;
  },
): CompScreening {
  const sale = reference.sale;
  const reasons: CompReason[] =
    target.status === "confirmed" && target.identity
      ? compareCompIdentity(sale, target.identity)
      : [{ code: "target-identity-unconfirmed", severity: "review" }];
  const price = normalizeSalePrice(sale, options.currency, options.conversion);
  const validDate =
    !!sale.date &&
    /^\d{4}-\d{2}-\d{2}$/.test(sale.date) &&
    Number.isFinite(Date.parse(sale.date)) &&
    new Date(sale.date).toISOString().slice(0, 10) === sale.date;
  if (!validDate)
    reasons.push({ code: "sale-date-unresolved", severity: "review" });
  else if (
    sale.date! < reference.window.from ||
    sale.date! > reference.window.to
  )
    reasons.push({ code: "outside-evidence-window", severity: "reject" });
  const unknownOutcome =
    !Number.isFinite(Date.parse(reference.fetchedAt)) ||
    (validDate && sale.date! > reference.fetchedAt.slice(0, 10)) ||
    sale.subjectToChange === true ||
    !sale.format ||
    /\b(active|open|unsold|cancelled|canceled)\b/i.test(sale.format);
  if (unknownOutcome)
    reasons.push({ code: "sale-outcome-unconfirmed", severity: "review" });
  if (sale.skippedReason)
    reasons.push({
      code: "provider-skipped-sale",
      actual: sale.skippedReason,
      severity: "review",
    });
  if (sale.kind === "listing-average" && sale.quantity !== 1)
    reasons.push({
      code: "grouped-average-not-an-individual-sale",
      severity: "review",
    });
  if (!price.itemOnly)
    reasons.push({ code: "item-price-unresolved", severity: "review" });
  reasons.push(
    ...price.reasons.map((code) => ({ code, severity: "review" as const })),
  );
  const supplied = options.decision;
  const decision =
    supplied &&
    supplied.revisionId === reference.revisionId &&
    supplied.provider === sale.provider &&
    supplied.providerId === sale.providerId &&
    supplied.date === sale.date &&
    supplied.valuationGroupKey === target.valuationGroupKey &&
    supplied.note.trim()
      ? supplied
      : null;
  if (supplied && !decision)
    reasons.push({ code: "comp-decision-is-stale", severity: "review" });
  if (decision?.decision === "exclude")
    reasons.push({
      code: "excluded-by-review",
      actual: decision.note,
      severity: "reject",
    });
  // A reviewed item amount is explicit input, not a guess that unknown fees/shipping are zero.
  if (
    decision?.decision === "accept" &&
    decision.itemPrice?.currency === options.currency &&
    Number.isFinite(decision.itemPrice.amount) &&
    decision.itemPrice.amount > 0 &&
    decision.itemPrice.amount < 1e9
  ) {
    price.itemOnly = decision.itemPrice;
    price.itemAndShipping = price.shipping
      ? {
          amount: decision.itemPrice.amount + price.shipping.amount,
          currency: options.currency,
        }
      : null;
    price.buyerTotal =
      price.itemAndShipping && price.fees
        ? {
            amount: price.itemAndShipping.amount + price.fees.amount,
            currency: options.currency,
          }
        : null;
  }
  const wrongReviewCurrency =
    !!decision?.itemPrice && decision.itemPrice.currency !== options.currency;
  if (wrongReviewCurrency)
    reasons.push({
      code: "reviewed-price-currency-mismatch",
      severity: "review",
    });
  const hardReject = reasons.some((reason) => reason.severity === "reject");
  const reviewed =
    decision?.decision === "accept" &&
    target.status === "confirmed" &&
    !!target.identity &&
    validDate &&
    !unknownOutcome &&
    !wrongReviewCurrency &&
    !!price.itemOnly;
  const status = hardReject
    ? "rejected"
    : reviewed || reasons.length === 0
      ? "accepted"
      : "needs-review";
  return { status, reference, reasons, price, decision };
}

export function screenCompetitorSupply(
  supply: SupplyEvidence,
  options: {
    ownEbayItemIds: ReadonlySet<string>;
    capturedAt: string;
    now: string;
    maxAgeMs: number;
  },
) {
  const reasons: string[] = [];
  let itemId = supply.provider === "ebayResearch" ? supply.providerId : null;
  if (!itemId && supply.sourceUrl) {
    try {
      const url = new URL(supply.sourceUrl);
      if (url.hostname === "ebay.com" || url.hostname.endsWith(".ebay.com"))
        itemId = /^\/itm\/(?:[^/]+\/)?(\d+)/.exec(url.pathname)?.[1] ?? null;
    } catch {}
  }
  if (itemId && options.ownEbayItemIds.has(itemId))
    reasons.push("own-current-listing");
  const age = Date.parse(options.now) - Date.parse(options.capturedAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    !Number.isFinite(options.maxAgeMs) ||
    options.maxAgeMs <= 0 ||
    age > options.maxAgeMs
  )
    reasons.push("supply-snapshot-stale");
  if (supply.priceKind !== "ask")
    reasons.push(
      supply.priceKind === "bid"
        ? "auction-bid-is-not-an-ask"
        : "price-kind-unknown",
    );
  if (
    !supply.price ||
    !supply.price.currency ||
    !Number.isFinite(supply.price.amount) ||
    supply.price.amount <= 0
  )
    reasons.push("asking-price-unresolved");
  if (!supply.state || !/^(active|available|live|listed)$/i.test(supply.state))
    reasons.push("listing-not-confirmed-active");
  return {
    status: reasons.includes("own-current-listing")
      ? ("excluded" as const)
      : reasons.length
        ? ("needs-review" as const)
        : ("candidate" as const),
    supply,
    reasons,
  };
}
