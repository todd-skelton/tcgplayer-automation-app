import type { InventoryRow } from "../inventory/slabInventory.server";
import type { StoredSlabRecommendation } from "../valuation/slabRecommendations.server";
import { minimumSellerAsk } from "../valuation/slabValuation";

export const SLAB_PUBLICATION_POLICY = "reviewed-price-v1";
export class SlabPublicationError extends Error {}
export type PublicationInventory = InventoryRow & { reviewReasons: string[] };
export type PreviewRequest = {
  intentId: string;
  inventoryId: string;
  inventoryRevision: number;
  recommendationId: string;
  selection: "calculated" | "reviewed";
  overrideReviewedAt: string | null;
};
export const publicationId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function previewRequest(input: PreviewRequest): PreviewRequest {
  if (
    !input ||
    ![input.intentId, input.inventoryId, input.recommendationId].every(
      publicationId,
    ) ||
    !Number.isSafeInteger(input.inventoryRevision) ||
    input.inventoryRevision < 1 ||
    !["calculated", "reviewed"].includes(input.selection) ||
    (input.selection === "reviewed" &&
      (typeof input.overrideReviewedAt !== "string" ||
        !Number.isFinite(Date.parse(input.overrideReviewedAt))))
  )
    throw new SlabPublicationError(
      "Select a saved recommendation and the current listing revision.",
    );
  return {
    intentId: input.intentId,
    inventoryId: input.inventoryId,
    inventoryRevision: input.inventoryRevision,
    recommendationId: input.recommendationId,
    selection: input.selection,
    overrideReviewedAt:
      input.selection === "reviewed" ? input.overrideReviewedAt : null,
  };
}
function cents(value: number) {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value >= 1e9 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 1e-5
  )
    throw new SlabPublicationError(
      "The selected USD item price must be positive and use whole cents.",
    );
  return Math.round(value * 100);
}
export function buildPublicationPreview(
  request: PreviewRequest,
  inventory: PublicationInventory,
  recommendation: StoredSlabRecommendation,
  now: string,
) {
  request = previewRequest(request);
  const calculation = recommendation.calculation;
  if (
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(now) < Date.parse(calculation.market.asOf) ||
    inventory.id !== request.inventoryId ||
    inventory.revision !== request.inventoryRevision ||
    recommendation.id !== request.recommendationId ||
    !recommendation.current ||
    inventory.identityId !== calculation.identity.slabId
  )
    throw new SlabPublicationError(
      "The listing, identity or recommendation changed. Reopen the listing and recalculate.",
    );
  if (
    calculation.policyVersion !== "slab-policy-v1" ||
    !calculation.market.range ||
    !calculation.evidence.length
  )
    throw new SlabPublicationError(
      "Use a supported recommendation with adequate direct sales evidence.",
    );
  const snapshot = inventory.snapshot;
  if (
    inventory.state !== "active" ||
    snapshot.state !== "active" ||
    snapshot.quantity !== 1 ||
    snapshot.format !== "fixed-price"
  )
    throw new SlabPublicationError(
      "Only active, single-quantity fixed-price slabs can be previewed.",
    );
  if (inventory.variationKey || snapshot.variationKey)
    throw new SlabPublicationError(
      "Variation listings need a verified variation publisher and remain in review.",
    );
  if (
    inventory.reviewReasons.some((reason) => reason !== "certificate-required")
  )
    throw new SlabPublicationError(
      "Resolve the listing's review reasons before preparing its price change.",
    );
  if (
    snapshot.price.currency !== "USD" ||
    calculation.policy.currency !== "USD" ||
    calculation.seller.currentAsk !== snapshot.price.amount ||
    calculation.seller.shippingCharged !== snapshot.shipping.amount ||
    (snapshot.shipping.amount !== null && snapshot.shipping.currency !== "USD")
  )
    throw new SlabPublicationError(
      "Recalculate using this listing's current USD price and shipping charge.",
    );
  const override =
    request.selection === "reviewed" ? recommendation.override : null;
  if (
    request.selection === "reviewed" &&
    (!override ||
      override.reviewedAt !== request.overrideReviewedAt ||
      override.currency !== "USD")
  )
    throw new SlabPublicationError(
      "The reviewed ask changed. Reload it before preparing the price change.",
    );
  const amount = override?.itemPrice ?? calculation.ask.proposedItemAsk;
  if (amount === null)
    throw new SlabPublicationError(
      "This recommendation has no item ask to publish.",
    );
  const oldCents = cents(snapshot.price.amount),
    newCents = cents(amount);
  if (oldCents === newCents)
    throw new SlabPublicationError(
      "The selected ask already matches the imported listing price.",
    );
  const floor = minimumSellerAsk(calculation.seller);
  if (
    floor === null ||
    !Number.isFinite(floor) ||
    newCents < Math.ceil(floor * 100 - 1e-9)
  )
    throw new SlabPublicationError(
      "The selected ask does not satisfy the saved seller constraints.",
    );
  const expiry = Math.min(
    Date.parse(now) + 15 * 60000,
    ...calculation.evidence.map((e) => Date.parse(e.expiresAt ?? "")),
  );
  if (!Number.isFinite(expiry) || expiry <= Date.parse(now))
    throw new SlabPublicationError(
      "The selected sales evidence expired. Refresh and recalculate.",
    );
  return {
    version: SLAB_PUBLICATION_POLICY,
    mode: "preview" as const,
    inventory: {
      id: inventory.id,
      revision: inventory.revision,
      seller: inventory.seller,
      itemId: inventory.itemId,
      variationKey: inventory.variationKey,
      source: inventory.source,
      observedAt: inventory.observedAt.toISOString(),
      snapshot: structuredClone(snapshot),
    },
    recommendationId: recommendation.id,
    identity: { ...calculation.identity },
    policyVersion: calculation.policyVersion,
    policy: { ...calculation.policy },
    sellerConstraints: structuredClone(calculation.seller),
    evidence: calculation.evidence.map((e) => ({
      revisionId: e.revisionId,
      expiresAt: e.expiresAt,
    })),
    selection: request.selection,
    override: override ? { ...override } : null,
    oldPrice: { amount: oldCents / 100, currency: "USD" },
    newPrice: { amount: newCents / 100, currency: "USD" },
    changePercent: ((newCents - oldCents) / oldCents) * 100,
    flags: [
      ...new Set(
        [
          ...calculation.market.flags,
          ...calculation.ask.flags,
          ...(Math.abs(newCents - oldCents) / oldCents >
          calculation.policy.reviewChangeFraction
            ? [{ code: "large-change-from-current-ask", review: true }]
            : []),
        ].map((flag) => flag.code),
      ),
    ],
    createdAt: now,
    expiresAt: new Date(expiry).toISOString(),
  };
}
export type PublicationPreview = ReturnType<typeof buildPublicationPreview>;
export function previewConflicts(
  plan: PublicationPreview,
  inventory: PublicationInventory | null,
  recommendation: StoredSlabRecommendation | null,
  now: string,
) {
  const reasons: string[] = [];
  if (
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(now) < Date.parse(plan.createdAt) ||
    Date.parse(now) >= Date.parse(plan.expiresAt)
  )
    reasons.push("preview-expired");
  if (plan.version !== SLAB_PUBLICATION_POLICY)
    reasons.push("publication-policy-changed");
  if (
    !inventory ||
    inventory.id !== plan.inventory.id ||
    inventory.revision !== plan.inventory.revision ||
    inventory.seller !== plan.inventory.seller ||
    inventory.itemId !== plan.inventory.itemId ||
    inventory.variationKey !== plan.inventory.variationKey ||
    inventory.identityId !== plan.identity.slabId ||
    inventory.state !== "active" ||
    inventory.reviewReasons.some((reason) => reason !== "certificate-required")
  )
    reasons.push("inventory-changed");
  if (
    !recommendation ||
    recommendation.id !== plan.recommendationId ||
    !recommendation.current ||
    recommendation.calculation.identity.revision !== plan.identity.revision
  )
    reasons.push("recommendation-changed");
  if (
    plan.selection === "reviewed" &&
    (!recommendation?.override ||
      !plan.override ||
      recommendation.override.itemPrice !== plan.override.itemPrice ||
      recommendation.override.currency !== plan.override.currency ||
      recommendation.override.note !== plan.override.note ||
      recommendation.override.reviewedAt !== plan.override.reviewedAt)
  )
    reasons.push("reviewed-ask-changed");
  return reasons;
}
