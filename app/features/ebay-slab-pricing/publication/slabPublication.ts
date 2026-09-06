import {
  normalizeCertificate,
  type Certificate,
} from "../identity/slabIdentity";
import {
  SlabPublicationError,
  type PublicationPreview,
} from "./slabPublicationPreview";

export type PublicationTarget = {
  seller: string;
  itemId: string;
  variationKey: string;
};
export type SellerListingState = PublicationTarget & {
  accountSeller: string;
  price: { amount: number; currency: string };
  quantity: number;
  state: "active" | "ended" | "sold";
  format: "fixed-price" | "auction" | "unknown";
  certificate: Certificate | null;
  title: string;
  shipping: {
    amount: number | null;
    currency: string | null;
    policyId: string | null;
  };
  // Adapter fingerprint of protected listing fields (title, shipping, offers, item specifics, etc.), excluding price.
  protectedRevision: string;
  observedAt: string;
  supported: boolean;
};
export type SlabPricePublisher = {
  id: string;
  kind: "seller-api" | "imported-inventory";
  read: (
    target: PublicationTarget,
    signal: AbortSignal,
  ) => Promise<SellerListingState>;
  // One item per write. Only identifiers, price and a correlation ID may be sent; never quantity or listing settings.
  write: (
    input: PublicationTarget & {
      intentId: string;
      price: SellerListingState["price"];
    },
    signal: AbortSignal,
  ) => Promise<"accepted" | "rejected" | "unknown">;
};
export class SlabPublisherError extends Error {
  constructor(
    public readonly code: "reconnect-required" | "unavailable" | "unsupported",
  ) {
    super(code);
  }
}
export type SlabPublicationPlan = {
  version: "slab-publication-v1";
  mode: "live" | "dry-run";
  publisherId: string;
  previewId: string;
  target: PublicationTarget;
  certificate: Certificate;
  before: SellerListingState;
  price: SellerListingState["price"];
  restoreOf: string | null;
  createdAt: string;
  expiresAt: string;
};
export type PublicationState =
  | "prepared"
  | "approved"
  | "checking"
  | "writing"
  | "reconcile"
  | "confirmed"
  | "conflict"
  | "failed"
  | "cancelled"
  | "dry-run";
export function listingState(input: SellerListingState): SellerListingState {
  if (
    !input ||
    !/^[a-z0-9_.-]{1,80}$/.test(input.seller) ||
    !/^[a-z0-9_.-]{1,80}$/.test(input.accountSeller) ||
    !/^\d{9,20}$/.test(input.itemId) ||
    typeof input.variationKey !== "string" ||
    input.variationKey.length > 160 ||
    !Number.isFinite(input.price?.amount) ||
    input.price.amount <= 0 ||
    input.price.amount >= 1e9 ||
    !/^[A-Z]{3}$/.test(input.price.currency) ||
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 0 ||
    input.quantity > 1e7 ||
    !["active", "ended", "sold"].includes(input.state) ||
    !["fixed-price", "auction", "unknown"].includes(input.format) ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 500 ||
    !/^[a-f0-9]{64}$/.test(input.protectedRevision) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    typeof input.supported !== "boolean" ||
    !input.shipping ||
    (input.shipping.amount !== null &&
      (!Number.isFinite(input.shipping.amount) || input.shipping.amount < 0)) ||
    (input.shipping.currency !== null &&
      !/^[A-Z]{3}$/.test(input.shipping.currency)) ||
    (input.shipping.policyId !== null &&
      (typeof input.shipping.policyId !== "string" ||
        input.shipping.policyId.length > 80))
  )
    throw new SlabPublisherError("unavailable");
  // Whitelist normalized fields. Provider payloads and incidental credentials never enter durable outcomes.
  return {
    seller: input.seller,
    accountSeller: input.accountSeller,
    itemId: input.itemId,
    variationKey: input.variationKey,
    price: { amount: input.price.amount, currency: input.price.currency },
    quantity: input.quantity,
    state: input.state,
    format: input.format,
    certificate: input.certificate
      ? normalizeCertificate(input.certificate)
      : null,
    title: input.title,
    shipping: {
      amount: input.shipping.amount,
      currency: input.shipping.currency,
      policyId: input.shipping.policyId,
    },
    protectedRevision: input.protectedRevision,
    observedAt: new Date(input.observedAt).toISOString(),
    supported: input.supported,
  };
}
export function listingConflicts(
  plan: Pick<SlabPublicationPlan, "target" | "certificate" | "before">,
  row: SellerListingState,
  price: SellerListingState["price"],
  now: string,
  notBefore?: string,
) {
  const reasons: string[] = [];
  if (
    row.accountSeller !== plan.target.seller ||
    row.seller !== plan.target.seller
  )
    reasons.push("wrong-seller");
  if (
    row.itemId !== plan.target.itemId ||
    row.variationKey !== plan.target.variationKey
  )
    reasons.push("wrong-listing");
  if (!row.supported || row.format !== "fixed-price" || row.variationKey)
    reasons.push("unsupported-listing");
  if (row.state !== "active" || row.quantity !== 1)
    reasons.push("listing-unavailable");
  if (
    row.certificate?.grader !== plan.certificate.grader ||
    row.certificate?.certificateNumber !== plan.certificate.certificateNumber
  )
    reasons.push("certificate-changed");
  if (
    row.price.currency !== price.currency ||
    row.price.amount !== price.amount
  )
    reasons.push("price-changed");
  if (
    row.protectedRevision !== plan.before.protectedRevision ||
    row.title !== plan.before.title ||
    row.shipping.amount !== plan.before.shipping.amount ||
    row.shipping.currency !== plan.before.shipping.currency ||
    row.shipping.policyId !== plan.before.shipping.policyId
  )
    reasons.push("listing-settings-changed");
  const observed = Date.parse(row.observedAt),
    asOf = Date.parse(now);
  if (
    !Number.isFinite(asOf) ||
    observed > asOf ||
    asOf - observed > 60000 ||
    (notBefore && observed < Date.parse(notBefore))
  )
    reasons.push("listing-read-stale");
  return reasons;
}
export function preparePublicationPlan(input: {
  previewId: string;
  preview: PublicationPreview;
  certificate: Certificate;
  before: SellerListingState;
  publisherId: string;
  mode: "live" | "dry-run";
  restoreOf?: string;
  now: string;
}): SlabPublicationPlan {
  const before = listingState(input.before),
    preview = input.preview;
  const target = {
    seller: preview.inventory.seller,
    itemId: preview.inventory.itemId,
    variationKey: preview.inventory.variationKey,
  };
  const certificate = normalizeCertificate(input.certificate);
  if (!/^[a-z0-9-]{1,80}$/.test(input.publisherId))
    throw new SlabPublicationError("Choose a supported publication provider.");
  const reasons = listingConflicts(
    { target, certificate, before },
    before,
    preview.oldPrice,
    input.now,
  );
  const snapshot = preview.inventory.snapshot;
  if (
    before.title !== snapshot.title ||
    before.shipping.amount !== snapshot.shipping.amount ||
    before.shipping.currency !== snapshot.shipping.currency ||
    (snapshot.shipping.policyId !== null &&
      snapshot.shipping.policyId !== before.shipping.policyId)
  )
    reasons.push("imported-listing-changed");
  const expires = Math.min(
    Date.parse(preview.expiresAt),
    Date.parse(input.now) + 5 * 60000,
  );
  if (!Number.isFinite(expires) || expires <= Date.parse(input.now))
    reasons.push("preview-expired");
  if (reasons.length)
    throw new SlabPublicationError(
      `Prepare a new review: ${[...new Set(reasons)].join(", ")}.`,
    );
  return {
    version: "slab-publication-v1",
    mode: input.mode,
    publisherId: input.publisherId,
    previewId: input.previewId,
    target,
    certificate,
    before,
    price: { ...preview.newPrice },
    restoreOf: input.restoreOf ?? null,
    createdAt: input.now,
    expiresAt: new Date(expires).toISOString(),
  };
}
