/**
 * Directional assumptions that stand in for missing order evidence. Strategy
 * needs a general sense of proceeds and cost, not audited financials, so each
 * gap is filled with the assumption that is normally true and labeled
 * estimated instead of blocking the order.
 */
export const STRATEGY_ASSUMPTIONS = [
  "An order with no refund status and no refund records had no refund.",
  "A refund without a recorded settlement reduces net proceeds by the refund's share of the gross order; a canceled order returns nothing.",
  "An order without purchased postage cost the seller's median purchased postage, or the default first-class rate when none was purchased.",
  "A lot without an intake market price is valued at the SKU's market price when the seller's inventory was first observed, else its current market price, else the seller's own listed price.",
  "Every purchase is funded on its purchase date; outside funding entries are optional.",
  "A canceled order that never shipped consumed no stock; a canceled order that shipped is a return that re-enters as new intake, so its sale stands.",
] as const;

/** First-class letter rate assumed when the seller has not purchased any postage yet. */
export const DEFAULT_POSTAGE_CENTS = 78;

export type RefundEvidence = { status: "none" } | { status: "known"; cents: number } | { status: "unknown" };

/** Reads refund records as the Seller Portal reports them: an empty status with no refunds is no refund. */
export function refundEvidence(refundStatus: string | null, refunds: unknown): RefundEvidence {
  if (!Array.isArray(refunds)) return { status: "unknown" };
  if (!refunds.length) return { status: "none" };
  const amounts = refunds.map((refund) =>
    refund && typeof refund === "object" ? (refund as { amount?: unknown }).amount : undefined);
  if (amounts.some((amount) => typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 ||
      !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7)) {
    return { status: "unknown" };
  }
  return { status: "known", cents: (amounts as number[]).reduce((sum, amount) => sum + Math.round(amount * 100), 0) };
}

export interface AssumedRefundSettlement {
  amountCents: number;
  provenance: "estimated";
  basis: "original_net_refund_adjustment" | "already_adjusted_net";
}

/**
 * Settlement assumed when a refund has no recorded settlement: the refund takes
 * the same share of net proceeds it took of the gross order, so fees are
 * treated as refunded proportionally. A canceled order keeps nothing.
 */
export function assumeRefundSettlement(order: {
  lifecycle: string; refundGrossCents: number; grossOrderCents: number | null; providerNetCents: number | null;
}): AssumedRefundSettlement {
  if (order.lifecycle === "canceled") return { amountCents: 0, provenance: "estimated", basis: "already_adjusted_net" };
  if (order.grossOrderCents === null || order.providerNetCents === null || order.grossOrderCents <= 0) {
    return { amountCents: order.refundGrossCents, provenance: "estimated", basis: "original_net_refund_adjustment" };
  }
  const share = Math.min(1, order.refundGrossCents / order.grossOrderCents);
  return { amountCents: Math.round(order.providerNetCents * share), provenance: "estimated", basis: "original_net_refund_adjustment" };
}

/** Postage assumed for an order without a purchased label: the median of what the seller paid elsewhere. */
export function assumePostageCents(knownPostageCents: readonly number[]): number {
  const sorted = [...knownPostageCents].filter((cents) => Number.isSafeInteger(cents) && cents >= 0).sort((a, b) => a - b);
  if (!sorted.length) return DEFAULT_POSTAGE_CENTS;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}