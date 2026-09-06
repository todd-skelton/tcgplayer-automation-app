export type ValuationPolicy = {
  currency: string;
  basis: "item-only" | "item-plus-shipping";
  minimumComps: number;
  minimumEffectiveCount: number;
  halfLifeDays: number;
  maximumAgeDays: number;
  roundingIncrement: number;
  reviewChangeFraction: number;
  reviewSpreadRatio: number;
};
export const DEFAULT_SLAB_POLICY: ValuationPolicy = {
  currency: "USD",
  basis: "item-plus-shipping",
  minimumComps: 3,
  minimumEffectiveCount: 2.5,
  halfLifeDays: 90,
  maximumAgeDays: 365,
  roundingIncrement: 0.01,
  reviewChangeFraction: 0.25,
  reviewSpreadRatio: 4,
};
export type DirectComp = {
  key: string;
  date: string;
  amount: number;
  currency: string;
  kind: "single-sale" | "listing-average";
  references: Array<{
    revisionId: string;
    provider: string;
    providerId: string;
    date: string | null;
  }>;
};
export type EvidenceQuality = {
  stale: boolean;
  capped: boolean;
  partial: boolean;
  uncertain: number;
  rejected: number;
  eventWarnings: string[];
};
export type ValuationFlag = { code: string; review: boolean };
export type MarketEstimate = {
  status: "direct-evidence" | "insufficient-evidence" | "needs-review";
  modelVersion: "direct-sales-v1";
  asOf: string;
  currency: string;
  basis: ValuationPolicy["basis"];
  range: {
    low: number;
    midpoint: number;
    high: number;
    meaning: "descriptive-middle-half";
    calibrated: false;
  } | null;
  observedSpan: { low: number; high: number } | null;
  count: number;
  effectiveCount: number;
  comps: Array<DirectComp & { ageDays: number; weight: number }>;
  excluded: Array<{ key: string; reason: string }>;
  quality: EvidenceQuality;
  flags: ValuationFlag[];
};
export class SlabValuationError extends Error {}
const money = (value: number | null) =>
  value === null || (Number.isFinite(value) && value >= 0 && value < 1e9);
const tidy = (value: number) => Math.round(value * 1e8) / 1e8;
export function validateValuationPolicy(policy: ValuationPolicy) {
  if (
    !policy ||
    !/^[A-Z]{3}$/.test(policy.currency) ||
    !["item-only", "item-plus-shipping"].includes(policy.basis) ||
    !Number.isInteger(policy.minimumComps) ||
    policy.minimumComps < 3 ||
    policy.minimumComps > 100 ||
    !Number.isFinite(policy.minimumEffectiveCount) ||
    policy.minimumEffectiveCount < 1 ||
    policy.minimumEffectiveCount > policy.minimumComps ||
    !Number.isFinite(policy.halfLifeDays) ||
    policy.halfLifeDays < 1 ||
    policy.halfLifeDays > 1095 ||
    !Number.isFinite(policy.maximumAgeDays) ||
    policy.maximumAgeDays < 1 ||
    policy.maximumAgeDays > 3660 ||
    ![0.01, 0.05, 0.1, 0.25, 0.5, 1].includes(policy.roundingIncrement) ||
    !Number.isFinite(policy.reviewChangeFraction) ||
    policy.reviewChangeFraction <= 0 ||
    policy.reviewChangeFraction > 1 ||
    !Number.isFinite(policy.reviewSpreadRatio) ||
    policy.reviewSpreadRatio < 2 ||
    policy.reviewSpreadRatio > 100
  )
    throw new SlabValuationError(
      "Provide a valid, bounded slab pricing policy.",
    );
  return {
    currency: policy.currency,
    basis: policy.basis,
    minimumComps: policy.minimumComps,
    minimumEffectiveCount: policy.minimumEffectiveCount,
    halfLifeDays: policy.halfLifeDays,
    maximumAgeDays: policy.maximumAgeDays,
    roundingIncrement: policy.roundingIncrement,
    reviewChangeFraction: policy.reviewChangeFraction,
    reviewSpreadRatio: policy.reviewSpreadRatio,
  };
}
export function estimateSlabMarket(input: {
  comps: DirectComp[];
  quality: EvidenceQuality;
  asOf: string;
  policy: ValuationPolicy;
}): MarketEstimate {
  const { quality, asOf } = input,
    policy = validateValuationPolicy(input.policy);
  const now = Date.parse(asOf);
  if (
    !Number.isFinite(now) ||
    !Array.isArray(input.comps) ||
    input.comps.length > 2000
  )
    throw new SlabValuationError(
      "Provide a calculation time and at most 2,000 comparable events.",
    );
  const excluded: MarketEstimate["excluded"] = [],
    comps: MarketEstimate["comps"] = [];
  const seen = new Set<string>();
  for (const comp of input.comps) {
    if (seen.has(comp.key))
      throw new SlabValuationError(
        "Deduplicate source events before calculating a range.",
      );
    seen.add(comp.key);
    const date =
      /^\d{4}-\d{2}-\d{2}$/.test(comp.date) &&
      Number.isFinite(Date.parse(comp.date)) &&
      new Date(comp.date).toISOString().slice(0, 10) === comp.date
        ? Date.parse(comp.date)
        : NaN;
    const ageDays = (now - date) / 86400000;
    const reason =
      !Number.isFinite(ageDays) || ageDays < 0
        ? "sale-date-unresolved"
        : ageDays > policy.maximumAgeDays
          ? "sale-outside-age-policy"
          : comp.currency !== policy.currency
            ? "currency-mismatch"
            : !money(comp.amount) || comp.amount <= 0
              ? "invalid-comp-price"
              : null;
    if (reason) {
      excluded.push({ key: comp.key, reason });
      continue;
    }
    comps.push({
      ...comp,
      ageDays,
      weight: Math.pow(2, -ageDays / policy.halfLifeDays),
    });
  }
  comps.sort((a, b) => a.amount - b.amount || a.key.localeCompare(b.key));
  const effectiveCount = comps.reduce((sum, comp) => sum + comp.weight, 0);
  const flags: ValuationFlag[] = [];
  if (quality.stale) flags.push({ code: "stale-evidence", review: true });
  if (quality.capped)
    flags.push({ code: "capped-source-history", review: false });
  if (quality.partial)
    flags.push({ code: "partial-market-coverage", review: false });
  if (comps.some((comp) => comp.kind === "listing-average"))
    flags.push({ code: "range-includes-grouped-means", review: true });
  quality.eventWarnings.forEach((code) => flags.push({ code, review: true }));
  const observedSpan = comps.length
    ? { low: comps[0].amount, high: comps[comps.length - 1].amount }
    : null;
  if (
    observedSpan &&
    observedSpan.high / observedSpan.low > policy.reviewSpreadRatio
  )
    flags.push({ code: "wide-observed-price-spread", review: true });
  const enough =
    comps.length >= policy.minimumComps &&
    effectiveCount >= policy.minimumEffectiveCount;
  if (!enough)
    flags.push({
      code:
        comps.length < policy.minimumComps
          ? "too-few-direct-comps"
          : "too-little-recent-evidence",
      review: true,
    });
  const quantile = (fraction: number) => {
    const threshold = fraction * effectiveCount;
    let cumulative = 0;
    for (const comp of comps) {
      cumulative += comp.weight;
      if (cumulative >= threshold) return comp.amount;
    }
    return comps[comps.length - 1].amount;
  };
  const range: MarketEstimate["range"] = enough
    ? {
        low: quantile(0.25),
        midpoint: quantile(0.5),
        high: quantile(0.75),
        meaning: "descriptive-middle-half",
        calibrated: false,
      }
    : null;
  const needsReview =
    flags.some((flag) => flag.review) ||
    (!comps.length && quality.uncertain > 0);
  return {
    status:
      !enough &&
      !quality.uncertain &&
      !quality.stale &&
      !quality.eventWarnings.length
        ? "insufficient-evidence"
        : needsReview
          ? "needs-review"
          : "direct-evidence",
    modelVersion: "direct-sales-v1",
    asOf,
    currency: policy.currency,
    basis: policy.basis,
    range,
    observedSpan,
    count: comps.length,
    effectiveCount: tidy(effectiveCount),
    comps,
    excluded,
    quality,
    flags,
  };
}

export type SellerPriceContext = {
  currency: string;
  currentAsk: number | null;
  shippingCharged: number | null;
  shippingCost: number | null;
  acquisitionCost: number | null;
  fees: {
    rate: number;
    fixed: number;
    basis: "item-only" | "item-plus-shipping";
  } | null;
  minimumAsk: number | null;
  minimumProfit: number | null;
};
export type SellerAsk = {
  proposedItemAsk: number | null;
  estimatedProceeds: number | null;
  estimatedProfit: number | null;
  appliedFloor: number | null;
  flags: ValuationFlag[];
  requiresReview: boolean;
};
export function validateSellerPriceContext(
  context: SellerPriceContext,
  currency: string,
): SellerPriceContext {
  if (
    !context ||
    context.currency !== currency ||
    [
      context.currentAsk,
      context.shippingCharged,
      context.shippingCost,
      context.acquisitionCost,
      context.minimumAsk,
      context.minimumProfit,
    ].some((value) => !money(value)) ||
    (context.fees &&
      (!Number.isFinite(context.fees.rate) ||
        context.fees.rate < 0 ||
        context.fees.rate >= 1 ||
        !Number.isFinite(context.fees.fixed) ||
        !money(context.fees.fixed) ||
        !["item-only", "item-plus-shipping"].includes(context.fees.basis)))
  )
    throw new SlabValuationError(
      "Provide seller costs and fees in the pricing currency; unknown values must be explicit nulls.",
    );
  return {
    currency: context.currency,
    currentAsk: context.currentAsk,
    shippingCharged: context.shippingCharged,
    shippingCost: context.shippingCost,
    acquisitionCost: context.acquisitionCost,
    fees: context.fees
      ? {
          rate: context.fees.rate,
          fixed: context.fees.fixed,
          basis: context.fees.basis,
        }
      : null,
    minimumAsk: context.minimumAsk,
    minimumProfit: context.minimumProfit,
  };
}
// Null means an explicitly requested profit floor cannot be checked with known seller inputs.
export function minimumSellerAsk(context: SellerPriceContext): number | null {
  const floor = context.minimumAsk ?? 0;
  if (context.minimumProfit === null) return floor;
  if (
    context.acquisitionCost === null ||
    context.shippingCost === null ||
    context.shippingCharged === null ||
    !context.fees
  )
    return null;
  const feeShipping =
    context.fees.basis === "item-plus-shipping"
      ? context.shippingCharged * context.fees.rate
      : 0;
  return Math.max(
    floor,
    (context.acquisitionCost +
      context.shippingCost +
      context.minimumProfit +
      context.fees.fixed -
      context.shippingCharged +
      feeShipping) /
      (1 - context.fees.rate),
  );
}
export function proposeSlabAsk(
  market: MarketEstimate,
  context: SellerPriceContext,
  policy: ValuationPolicy,
): SellerAsk {
  validateValuationPolicy(policy);
  context = validateSellerPriceContext(context, policy.currency);
  if (market.currency !== policy.currency || market.basis !== policy.basis)
    throw new SlabValuationError(
      "Use the market estimate's currency and price basis.",
    );
  const flags: ValuationFlag[] = [...market.flags];
  const result: SellerAsk = {
    proposedItemAsk: null,
    estimatedProceeds: null,
    estimatedProfit: null,
    appliedFloor: null,
    flags,
    requiresReview: market.status !== "direct-evidence",
  };
  const currentComparable =
    context.currentAsk !== null &&
    (market.basis === "item-only" || context.shippingCharged !== null)
      ? context.currentAsk +
        (market.basis === "item-plus-shipping" ? context.shippingCharged! : 0)
      : null;
  if (!market.range) {
    if (
      currentComparable !== null &&
      market.observedSpan &&
      currentComparable >
        market.observedSpan.high * (1 + policy.reviewChangeFraction)
    )
      flags.push({
        code: "current-ask-above-sparse-observed-sales",
        review: true,
      });
    return result;
  }
  if (
    market.basis === "item-plus-shipping" &&
    context.shippingCharged === null
  ) {
    flags.push({ code: "seller-shipping-charge-unresolved", review: true });
    result.requiresReview = true;
    return result;
  }
  let ask =
    market.range.midpoint -
    (market.basis === "item-plus-shipping" ? context.shippingCharged! : 0);
  const floor = minimumSellerAsk(context);
  if (floor === null) {
    flags.push({ code: "profit-floor-cannot-be-verified", review: true });
    result.requiresReview = true;
    return result;
  }
  if (floor > ask) {
    flags.push({ code: "seller-floor-raised-proposed-ask", review: false });
    result.appliedFloor = floor;
    ask = floor;
  }
  if (ask <= 0 || !money(ask)) {
    flags.push({
      code:
        ask <= 0
          ? "seller-shipping-exceeds-market-value"
          : "proposed-ask-out-of-range",
      review: true,
    });
    result.requiresReview = true;
    return result;
  }
  ask = tidy(
    Math.ceil(ask / policy.roundingIncrement - 1e-9) * policy.roundingIncrement,
  );
  result.proposedItemAsk = ask;
  if (
    context.currentAsk !== null &&
    (context.currentAsk === 0 ||
      Math.abs(ask - context.currentAsk) / context.currentAsk >
        policy.reviewChangeFraction)
  )
    flags.push({ code: "large-change-from-current-ask", review: true });
  if (
    context.shippingCharged !== null &&
    context.shippingCost !== null &&
    context.fees
  ) {
    const feeBase =
      ask +
      (context.fees.basis === "item-plus-shipping"
        ? context.shippingCharged
        : 0);
    result.estimatedProceeds = tidy(
      ask +
        context.shippingCharged -
        feeBase * context.fees.rate -
        context.fees.fixed -
        context.shippingCost,
    );
    result.estimatedProfit =
      context.acquisitionCost === null
        ? null
        : tidy(result.estimatedProceeds - context.acquisitionCost);
  } else
    flags.push({
      code: "proceeds-unknown-without-shipping-and-fees",
      review: false,
    });
  if (context.acquisitionCost === null)
    flags.push({
      code: "profit-unknown-without-acquisition-cost",
      review: false,
    });
  result.requiresReview ||= flags.some((flag) => flag.review);
  return result;
}
