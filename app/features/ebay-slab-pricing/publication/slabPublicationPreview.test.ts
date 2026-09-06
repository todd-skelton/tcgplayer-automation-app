import assert from "node:assert/strict";
import type { PublicationInventory } from "./slabPublicationPreview";
import type { StoredSlabRecommendation } from "../valuation/slabRecommendations.server";
import {
  DEFAULT_SLAB_POLICY,
  estimateSlabMarket,
  proposeSlabAsk,
  type SellerPriceContext,
} from "../valuation/slabValuation";
import {
  buildPublicationPreview,
  previewConflicts,
  type PreviewRequest,
} from "./slabPublicationPreview";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const now = "2026-09-06T00:00:00.000Z";
const seller: SellerPriceContext = {
  currency: "USD",
  currentAsk: 100,
  shippingCharged: 0,
  shippingCost: null,
  acquisitionCost: null,
  fees: null,
  minimumAsk: null,
  minimumProfit: null,
};
const market = estimateSlabMarket({
  policy: DEFAULT_SLAB_POLICY,
  asOf: now,
  quality: {
    stale: false,
    capped: false,
    partial: true,
    uncertain: 0,
    rejected: 0,
    eventWarnings: [],
  },
  comps: [100, 110, 120, 130].map((amount, i) => ({
    key: String(i),
    amount,
    currency: "USD",
    date: "2026-09-05",
    kind: "single-sale",
    references: [
      {
        revisionId: id(4),
        provider: "fixture",
        providerId: String(i),
        date: "2026-09-05",
      },
    ],
  })),
});
const recommendation: StoredSlabRecommendation = {
  id: id(3),
  current: true,
  override: {
    itemPrice: 125,
    currency: "USD",
    note: "Reviewed fixture",
    reviewedAt: now,
  },
  calculation: {
    identity: { slabId: id(2), revision: 1, valuationGroupKey: "a".repeat(64) },
    policyVersion: "slab-policy-v1",
    policy: DEFAULT_SLAB_POLICY,
    seller,
    market,
    ask: proposeSlabAsk(market, seller, DEFAULT_SLAB_POLICY),
    dispositions: [],
    decisions: [],
    evidence: [
      {
        revisionId: id(4),
        fetchedAt: now,
        expiresAt: "2026-09-06T06:00:00.000Z",
        spec: {
          kind: "alt-sales",
          assetId: "fixture",
          window: { from: "2026-09-01", to: "2026-09-05" },
          limitPerGrade: 16,
        },
      },
    ],
  },
};
const inventory: PublicationInventory = {
  reviewReasons: ["certificate-required"],
  id: id(1),
  seller: "fixture",
  itemId: "123456789012",
  variationKey: "",
  source: "csv",
  state: "active",
  revision: 1,
  identityId: id(2),
  identitySource: "manual",
  identityNote: "Fixture",
  observedAt: new Date(now),
  snapshot: {
    itemId: "123456789012",
    variationKey: "",
    sku: null,
    title: "Fixture PSA 1 slab",
    price: { amount: 100, currency: "USD" },
    shipping: { amount: 0, currency: "USD", policyId: null },
    quantity: 1,
    state: "active",
    format: "fixed-price",
    certificate: null,
    expected: {},
    specifics: {},
    reviewReasons: ["certificate-required"],
  },
};
const request: PreviewRequest = {
  intentId: id(5),
  inventoryId: inventory.id,
  inventoryRevision: 1,
  recommendationId: recommendation.id,
  selection: "reviewed",
  overrideReviewedAt: now,
};
const build = (row = inventory, rec = recommendation, input = request) =>
  buildPublicationPreview(input, row, rec, now);
const plan = build();
assert.throws(
  () =>
    build({
      ...inventory,
      reviewReasons: ["certificate-used-by-another-active-listing"],
    }),
  /review reasons/,
);
assert.throws(
  () =>
    build({
      ...inventory,
      reviewReasons: ["listing-certificate-conflicts-with-manual-identity"],
    }),
  /review reasons/,
);
assert.equal(plan.mode, "preview");
assert.equal(plan.oldPrice.amount, 100);
assert.equal(plan.newPrice.amount, 125);
assert.equal(plan.expiresAt, "2026-09-06T00:15:00.000Z");
assert.deepEqual(previewConflicts(plan, inventory, recommendation, now), []);
assert.ok(
  build(inventory, {
    ...recommendation,
    override: { ...recommendation.override!, itemPrice: 126 },
  }).flags.includes("large-change-from-current-ask"),
);
const profitable = {
  ...recommendation,
  calculation: {
    ...recommendation.calculation,
    seller: {
      ...seller,
      acquisitionCost: 80,
      shippingCost: 5,
      fees: { rate: 0.1, fixed: 0.3, basis: "item-plus-shipping" as const },
      minimumProfit: 20,
    },
  },
};
assert.equal(build(inventory, profitable).newPrice.amount, 125);
assert.throws(
  () =>
    build(inventory, {
      ...profitable,
      override: { ...recommendation.override!, itemPrice: 116.99 },
    }),
  /constraints/,
);
assert.equal(
  build(inventory, recommendation, {
    ...request,
    selection: "calculated",
    overrideReviewedAt: null,
  }).newPrice.amount,
  market.range!.midpoint,
);
assert.throws(() => build({ ...inventory, state: "sold" }), /active/);
assert.throws(() => build({ ...inventory, state: "ended" }), /active/);
assert.throws(
  () =>
    build({ ...inventory, snapshot: { ...inventory.snapshot, quantity: 0 } }),
  /active/,
);
assert.throws(
  () =>
    build({ ...inventory, snapshot: { ...inventory.snapshot, quantity: 2 } }),
  /single-quantity/,
);
assert.throws(
  () =>
    build({
      ...inventory,
      snapshot: { ...inventory.snapshot, format: "auction" },
    }),
  /fixed-price/,
);
assert.throws(
  () => build({ ...inventory, variationKey: "sku:variation" }),
  /Variation/,
);
assert.throws(() => build({ ...inventory, revision: 2 }), /changed/);
assert.throws(() => build({ ...inventory, identityId: id(6) }), /identity/);
assert.throws(
  () => build(inventory, { ...recommendation, current: false }),
  /changed/,
);
assert.throws(
  () =>
    build({
      ...inventory,
      snapshot: {
        ...inventory.snapshot,
        price: { amount: 101, currency: "USD" },
      },
    }),
  /Recalculate/,
);
assert.throws(
  () =>
    build({
      ...inventory,
      snapshot: {
        ...inventory.snapshot,
        price: { amount: 100, currency: "CAD" },
      },
    }),
  /USD/,
);
assert.throws(
  () =>
    build({
      ...inventory,
      snapshot: {
        ...inventory.snapshot,
        shipping: { amount: 5, currency: "USD", policyId: null },
      },
    }),
  /shipping/,
);
assert.throws(
  () =>
    build(inventory, {
      ...recommendation,
      override: {
        ...recommendation.override!,
        reviewedAt: "2026-09-06T00:01:00.000Z",
      },
    }),
  /reviewed ask changed/,
);
assert.throws(
  () =>
    build(inventory, {
      ...recommendation,
      override: { ...recommendation.override!, itemPrice: 100 },
    }),
  /already matches/,
);
assert.throws(
  () =>
    build(inventory, {
      ...recommendation,
      override: { ...recommendation.override!, itemPrice: 125.001 },
    }),
  /whole cents/,
);
assert.throws(
  () =>
    build(inventory, {
      ...recommendation,
      calculation: {
        ...recommendation.calculation,
        seller: { ...seller, minimumAsk: 130 },
      },
    }),
  /constraints/,
);
assert.throws(
  () =>
    build(inventory, {
      ...recommendation,
      calculation: {
        ...recommendation.calculation,
        seller: { ...seller, minimumProfit: 20 },
      },
    }),
  /constraints/,
);
assert.throws(
  () =>
    build(inventory, {
      ...recommendation,
      calculation: {
        ...recommendation.calculation,
        evidence: [
          { ...recommendation.calculation.evidence[0], expiresAt: now },
        ],
      },
    }),
  /expired/,
);
assert.throws(
  () =>
    build(inventory, {
      ...recommendation,
      calculation: {
        ...recommendation.calculation,
        market: { ...market, range: null },
      },
    }),
  /adequate/,
);
assert.ok(
  previewConflicts(
    plan,
    { ...inventory, seller: "other-seller" },
    recommendation,
    now,
  ).includes("inventory-changed"),
);
assert.ok(
  previewConflicts(
    plan,
    inventory,
    { ...recommendation, current: false },
    now,
  ).includes("recommendation-changed"),
);
assert.ok(
  previewConflicts(
    plan,
    inventory,
    {
      ...recommendation,
      override: { ...recommendation.override!, note: "Changed" },
    },
    now,
  ).includes("reviewed-ask-changed"),
);
assert.ok(
  previewConflicts(plan, inventory, recommendation, plan.expiresAt).includes(
    "preview-expired",
  ),
);
const changed = structuredClone(inventory);
changed.snapshot.title = "Changed after preparation";
assert.notEqual(
  plan.inventory.snapshot.title,
  changed.snapshot.title,
  "The saved plan owns an immutable snapshot",
);
console.log(
  "PASS immutable publication previews, exact price selection, seller constraints, listing conflicts, stale evidence and unsupported types",
);
