import assert from "node:assert/strict";
import {
  DEFAULT_SLAB_POLICY,
  estimateSlabMarket,
  proposeSlabAsk,
  type DirectComp,
  type EvidenceQuality,
  type SellerPriceContext,
} from "./slabValuation";
import { collectDirectComps } from "./directCompInputs";
import {
  compReference,
  compSale,
  compTarget,
} from "../screening/screenComparables.test";

export const sellerContext: SellerPriceContext = {
  currency: "USD",
  currentAsk: 100,
  shippingCharged: 0,
  shippingCost: null,
  acquisitionCost: null,
  fees: null,
  minimumAsk: null,
  minimumProfit: null,
};
const quality: EvidenceQuality = {
  stale: false,
  capped: false,
  partial: false,
  uncertain: 0,
  rejected: 0,
  eventWarnings: [],
};
const asOf = "2026-09-05T12:00:00Z";
const comp = (
  amount: number,
  index: number,
  date = "2026-09-04",
): DirectComp => ({
  key: `event-${index}`,
  amount,
  currency: "USD",
  date,
  kind: "single-sale",
  references: [
    {
      revisionId: `revision-${index}`,
      provider: "alt",
      providerId: `sale-${index}`,
      date,
    },
  ],
});
const estimate = (
  comps: DirectComp[],
  changed: Partial<EvidenceQuality> = {},
) =>
  estimateSlabMarket({
    comps,
    quality: { ...quality, ...changed },
    asOf,
    policy: DEFAULT_SLAB_POLICY,
  });
assert.equal(estimate([]).status, "insufficient-evidence");
assert.equal(estimate([]).range, null);
assert.equal(estimate([], { uncertain: 5 }).status, "needs-review");
assert.equal(estimate([comp(100, 1)]).range, null);
const prices = [90, 100, 110].map((amount, index) => comp(amount, index));
const market = estimate(prices);
assert.equal(market.status, "direct-evidence");
assert.equal(market.range?.midpoint, 100);
assert.equal(market.range?.calibrated, false);
assert.deepEqual(
  estimate(prices),
  market,
  "same inputs produce the same calculation",
);
const ask = proposeSlabAsk(market, sellerContext, DEFAULT_SLAB_POLICY);
assert.equal(ask.proposedItemAsk, 100);
assert.equal(ask.estimatedProfit, null);
assert.equal(ask.estimatedProceeds, null);
assert.equal(
  proposeSlabAsk(
    market,
    { ...sellerContext, shippingCharged: 5 },
    DEFAULT_SLAB_POLICY,
  ).proposedItemAsk,
  95,
);
assert.equal(
  proposeSlabAsk(
    market,
    { ...sellerContext, shippingCharged: null },
    DEFAULT_SLAB_POLICY,
  ).proposedItemAsk,
  null,
);
assert.equal(
  estimate(prices, { capped: true, partial: true }).range?.midpoint,
  100,
);
assert.ok(
  estimate(prices, { capped: true }).flags.some(
    (flag) => flag.code === "capped-source-history",
  ),
);
assert.equal(estimate(prices, { stale: true }).status, "needs-review");
assert.equal(
  estimate(prices.map((row) => ({ ...row, date: "2020-01-01" }))).range,
  null,
);
assert.equal(
  estimate(prices.map((row) => ({ ...row, date: "2026-01-01" }))).range,
  null,
  "recency lowers effective evidence count even for equal-age sales",
);
assert.equal(
  estimate(prices.map((row) => ({ ...row, currency: "EUR" }))).range,
  null,
);
const mean = estimate(
  prices.map((row) => ({ ...row, kind: "listing-average" as const })),
);
assert.equal(mean.count, 3);
assert.equal(mean.status, "needs-review");
const extreme = estimate([...prices, comp(10000, 10)]);
assert.equal(extreme.count, 4);
assert.equal(extreme.status, "needs-review");
assert.equal(extreme.observedSpan?.high, 10000);
assert.ok(
  extreme.comps.some((row) => row.amount === 10000),
  "legitimate premium remains in the evidence",
);
const floor = proposeSlabAsk(
  market,
  {
    ...sellerContext,
    acquisitionCost: 120,
    shippingCost: 5,
    shippingCharged: 5,
    fees: { rate: 0.1, fixed: 0.3, basis: "item-plus-shipping" },
    minimumProfit: 10,
  },
  DEFAULT_SLAB_POLICY,
);
assert.equal(floor.proposedItemAsk, 145.34);
assert.ok(floor.estimatedProfit! >= 10);
assert.ok(
  floor.flags.some((flag) => flag.code === "seller-floor-raised-proposed-ask"),
);
assert.equal(
  proposeSlabAsk(
    market,
    { ...sellerContext, minimumProfit: 0 },
    DEFAULT_SLAB_POLICY,
  ).proposedItemAsk,
  null,
);
assert.equal(
  proposeSlabAsk(
    market,
    { ...sellerContext, minimumAsk: 100.001 },
    DEFAULT_SLAB_POLICY,
  ).proposedItemAsk,
  100.01,
);
assert.equal(
  proposeSlabAsk(
    market,
    { ...sellerContext, currentAsk: 200 },
    DEFAULT_SLAB_POLICY,
  ).requiresReview,
  true,
);
assert.throws(() =>
  proposeSlabAsk(
    market,
    { ...sellerContext, fees: { rate: 1, fixed: 0, basis: "item-only" } },
    DEFAULT_SLAB_POLICY,
  ),
);
assert.throws(() =>
  proposeSlabAsk(
    market,
    {
      ...sellerContext,
      fees: { rate: 0.1, fixed: null as unknown as number, basis: "item-only" },
    },
    DEFAULT_SLAB_POLICY,
  ),
);
assert.throws(() =>
  estimateSlabMarket({
    comps: prices,
    quality,
    asOf,
    policy: { ...DEFAULT_SLAB_POLICY, roundingIncrement: 0 },
  }),
);
assert.throws(() => estimate([prices[0], prices[0]]));
// Exact item+shipping amounts and dates from the captured store evaluation, even assuming identity review succeeds.
for (const sample of [
  {
    name: "Slaking PSA 9",
    ask: 100,
    sales: [comp(16, 1, "2026-07-08"), comp(20.72, 2, "2026-07-26")],
  },
  {
    name: "Buneary Master Ball PSA 10",
    ask: 215,
    sales: [comp(104.99, 1, "2026-07-24"), comp(116.98, 2, "2026-06-08")],
  },
]) {
  const sparse = estimate(sample.sales),
    proposal = proposeSlabAsk(
      sparse,
      { ...sellerContext, currentAsk: sample.ask },
      DEFAULT_SLAB_POLICY,
    );
  assert.equal(sparse.range, null, sample.name);
  assert.equal(proposal.proposedItemAsk, null, sample.name);
  assert.ok(
    proposal.flags.some(
      (flag) => flag.code === "current-ask-above-sparse-observed-sales",
    ),
    sample.name,
  );
}
const direct = collectDirectComps(
  [compReference],
  compTarget,
  [],
  DEFAULT_SLAB_POLICY,
);
const copy = {
  ...compReference,
  revisionId: "ebay-copy",
  sale: {
    ...compSale,
    provider: "ebayResearch" as const,
    providerId: compSale.sourceItemId!,
    kind: "listing-average" as const,
  },
};
const wrongSource = {
  ...compReference,
  sale: { ...compSale, price: { amount: 200, currency: "USD" } },
};
assert.equal(
  collectDirectComps([wrongSource, copy], compTarget, [], DEFAULT_SLAB_POLICY)
    .comps.length,
  0,
);
const reviewedExclusion = collectDirectComps(
  [wrongSource, copy],
  compTarget,
  [
    {
      revisionId: compReference.revisionId,
      provider: compSale.provider,
      providerId: compSale.providerId,
      date: compSale.date,
      valuationGroupKey: compTarget.valuationGroupKey!,
      decision: "exclude",
      note: "This source reported an incorrect amount",
      itemPrice: null,
    },
  ],
  DEFAULT_SLAB_POLICY,
);
assert.equal(reviewedExclusion.comps.length, 1);
assert.equal(reviewedExclusion.comps[0].amount, 100);
assert.equal(direct.comps.length, 1);
assert.equal(direct.comps[0].amount, 100);
const missingShipping = collectDirectComps(
  [{ ...compReference, sale: { ...compSale, shipping: null } }],
  compTarget,
  [
    {
      revisionId: compReference.revisionId,
      provider: compSale.provider,
      providerId: compSale.providerId,
      date: compSale.date,
      valuationGroupKey: compTarget.valuationGroupKey!,
      decision: "accept",
      note: "Verified item quote",
      itemPrice: { amount: 100, currency: "USD" },
    },
  ],
  DEFAULT_SLAB_POLICY,
);
assert.equal(missingShipping.comps.length, 0);
assert.equal(missingShipping.dispositions[0].status, "needs-review");
console.log(
  "PASS direct weighted ranges, sparse examples, coverage, grouped means, premiums, money uncertainty, seller floors and rounding",
);
