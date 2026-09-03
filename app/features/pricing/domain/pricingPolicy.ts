import type { PricingPercentileDetail } from "~/core/types/pricing";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import type {
  PortfolioPricingPlan,
  PortfolioMatchStatus,
  PricingConstraint,
  PricingCurvePoint,
  PricingDecision,
  PricingPolicy,
} from "~/core/types/pricingPolicy";

export type {
  PortfolioMatchStatus,
  PortfolioPricingPlan,
  PricingConstraint,
  PricingCurvePoint,
  PricingDecision,
  PricingDecisionBasis,
  PricingForecastStatus,
  PricingPolicy,
} from "~/core/types/pricingPolicy";

export interface PriceConstraintResult {
  price: number;
  constraint: PricingConstraint;
}

export interface PortfolioCurveItem {
  sku: number;
  currentPrice?: number;
  curve: PricingCurvePoint[];
  constraintIdentity?: string;
  applyConstraint?: (price: number) => PriceConstraintResult;
}

export interface ResolvedPortfolioPricing {
  plan: PortfolioPricingPlan;
  decisionsBySku: Map<number, PricingDecision>;
}

interface PersistedDecisionLike {
  pricingModelVersion?: string;
  decision?: PricingDecision;
  shadowDecision?: PricingDecision;
  percentileUsed?: number;
  suggestedPrice?: number;
  marketplacePrice?: number;
  historicalSalesVelocityDays?: number;
  estimatedTimeToSellDays?: number;
  percentiles?: PricingPercentileDetail[];
}

interface PortfolioPlanOptions {
  createdAt?: Date;
  cohortId?: string;
}

const SAMPLE_COUNT = 64;
const REFINEMENT_ITERATIONS = 32;
const roundCurrency = (value: number): number => Math.round(value * 100) / 100;
const clampPercentile = (value: number): number =>
  Math.max(0, Math.min(100, value));

export function toPricingCurve(
  details: readonly PricingPercentileDetail[] | undefined,
): PricingCurvePoint[] {
  return (details ?? [])
    .filter(
      (detail) =>
        Number.isFinite(detail.percentile) &&
        Number.isFinite(detail.suggestedPrice) &&
        detail.suggestedPrice > 0,
    )
    .map((detail) => {
      const buyerIntervalDays = isPositive(detail.historicalSalesVelocityDays)
        ? detail.historicalSalesVelocityDays
        : undefined;
      const storeWinShare = isPositive(detail.storeWinShare)
        ? detail.storeWinShare
        : undefined;
      return {
        percentile: detail.percentile,
        price: detail.suggestedPrice,
        buyerIntervalDays,
        storeWinShare,
        estimatedMedianSellDays: medianSellDays(
          buyerIntervalDays,
          storeWinShare,
          detail.estimatedTimeToSellDays,
        ),
        qualifyingSalesCount: detail.salesCount,
        historyCapped: detail.historyCapped,
        listingsCount: detail.listingsCount,
        supplyStatus: detail.supplyStatus,
      };
    })
    .sort((left, right) => left.percentile - right.percentile);
}

function mixOptional(
  left: number | undefined,
  right: number | undefined,
  ratio: number,
): number | undefined {
  if (ratio <= 0) return left;
  if (ratio >= 1) return right;
  return left === undefined || right === undefined
    ? undefined
    : left + (right - left) * ratio;
}

function isPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function medianSellDays(
  buyerIntervalDays: number | undefined,
  storeWinShare: number | undefined,
  fallback: number | undefined,
): number | undefined {
  return isPositive(buyerIntervalDays) && isPositive(storeWinShare)
    ? (Math.LN2 * buyerIntervalDays) / storeWinShare
    : fallback;
}

function interpolate(
  lower: PricingCurvePoint,
  upper: PricingCurvePoint,
  ratio: number,
): PricingCurvePoint {
  const buyerIntervalDays = mixOptional(
    lower.buyerIntervalDays,
    upper.buyerIntervalDays,
    ratio,
  );
  const storeWinShare = mixOptional(
    lower.storeWinShare,
    upper.storeWinShare,
    ratio,
  );
  const interpolatedMedian = mixOptional(
    lower.estimatedMedianSellDays,
    upper.estimatedMedianSellDays,
    ratio,
  );

  return {
    percentile: clampPercentile(
      lower.percentile + (upper.percentile - lower.percentile) * ratio,
    ),
    price: roundCurrency(lower.price + (upper.price - lower.price) * ratio),
    buyerIntervalDays,
    storeWinShare,
    estimatedMedianSellDays: medianSellDays(
      buyerIntervalDays,
      storeWinShare,
      interpolatedMedian,
    ),
    qualifyingSalesCount: mixOptional(
      lower.qualifyingSalesCount,
      upper.qualifyingSalesCount,
      ratio,
    ),
    historyCapped: lower.historyCapped || upper.historyCapped,
    listingsCount: mixOptional(lower.listingsCount, upper.listingsCount, ratio),
    supplyStatus:
      lower.supplyStatus === upper.supplyStatus
        ? lower.supplyStatus
        : undefined,
  };
}

function pointAtPercentile(
  curve: readonly PricingCurvePoint[],
  percentile: number,
): PricingCurvePoint | undefined {
  const points = [...curve].sort(
    (left, right) => left.percentile - right.percentile,
  );
  if (points.length === 0) return undefined;
  if (percentile <= points[0].percentile) return points[0];
  if (percentile >= points.at(-1)!.percentile) return points.at(-1);
  const upperIndex = points.findIndex(
    (point) => point.percentile >= percentile,
  );
  const upper = points[upperIndex];
  const lower = points[upperIndex - 1];
  const span = upper.percentile - lower.percentile;
  return interpolate(
    lower,
    upper,
    span === 0 ? 0 : (percentile - lower.percentile) / span,
  );
}

function pointAtHorizon(
  curve: readonly PricingCurvePoint[],
  horizonDays: number,
): PricingCurvePoint | undefined {
  const points = curve
    .map((point) => ({
      ...point,
      estimatedMedianSellDays: medianSellDays(
        point.buyerIntervalDays,
        point.storeWinShare,
        point.estimatedMedianSellDays,
      ),
    }))
    .filter((point) => {
      const median = point.estimatedMedianSellDays;
      return (
        point.supplyStatus === "observed" &&
        median !== undefined &&
        Number.isFinite(median) &&
        median > 0
      );
    })
    .sort(
      (left, right) =>
        left.estimatedMedianSellDays! - right.estimatedMedianSellDays!,
    );
  if (points.length === 0) return undefined;
  if (horizonDays <= points[0].estimatedMedianSellDays!) return points[0];
  if (horizonDays >= points.at(-1)!.estimatedMedianSellDays!)
    return points.at(-1);
  const upperIndex = points.findIndex(
    (point) => point.estimatedMedianSellDays! >= horizonDays,
  );
  const upper = points[upperIndex];
  const lower = points[upperIndex - 1];
  if (lower.estimatedMedianSellDays === upper.estimatedMedianSellDays)
    return lower;
  return interpolate(lower, upper, horizonRatio(lower, upper, horizonDays));
}

/**
 * Position of a horizon between two curve points. Interpolation mixes buyer
 * interval and win share linearly, so the median (ln2 · interval / share) is
 * a linear-fractional function of the ratio and inverts in closed form. When
 * either input is missing the stored median mixes linearly instead. Curves
 * from toPricingCurve carry those inputs only when positive, so the branch
 * here matches the one interpolate takes.
 */
function horizonRatio(
  lower: PricingCurvePoint,
  upper: PricingCurvePoint,
  horizonDays: number,
): number {
  const lowerMedian = lower.estimatedMedianSellDays ?? 0;
  const upperMedian = upper.estimatedMedianSellDays ?? 0;
  const ratio =
    isPositive(lower.buyerIntervalDays) &&
    isPositive(upper.buyerIntervalDays) &&
    isPositive(lower.storeWinShare) &&
    isPositive(upper.storeWinShare)
      ? (horizonDays * lower.storeWinShare -
          Math.LN2 * lower.buyerIntervalDays) /
        (Math.LN2 * (upper.buyerIntervalDays - lower.buyerIntervalDays) -
          horizonDays * (upper.storeWinShare - lower.storeWinShare))
      : (horizonDays - lowerMedian) / (upperMedian - lowerMedian);
  return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
}

function pointAtPrice(
  curve: readonly PricingCurvePoint[],
  price: number,
): PricingCurvePoint | undefined {
  const points = [...curve].sort(
    (left, right) =>
      left.price - right.price || left.percentile - right.percentile,
  );
  if (points.length === 0) return undefined;
  if (price <= points[0].price) return points[0];
  if (price >= points.at(-1)!.price) return points.at(-1);
  const upperIndex = points.findIndex((point) => point.price >= price);
  const upper = points[upperIndex];
  const lower = points[upperIndex - 1];
  const span = upper.price - lower.price;
  return interpolate(
    lower,
    upper,
    span === 0 ? 0 : (price - lower.price) / span,
  );
}

export function selectPricingDecision(
  curve: readonly PricingCurvePoint[],
  policy: PricingPolicy,
  currentPrice?: number,
  applyConstraint?: (price: number) => PriceConstraintResult,
): PricingDecision | undefined {
  const requestedPoint =
    policy.method === "percentile"
      ? pointAtPercentile(curve, policy.percentile)
      : pointAtHorizon(curve, policy.horizonDays);
  if (!requestedPoint) {
    return currentPrice && currentPrice > 0
      ? {
          method: policy.method,
          selectedPrice: roundCurrency(currentPrice),
          unconstrainedPrice: roundCurrency(currentPrice),
          configuredPercentile:
            policy.method === "percentile" ? policy.percentile : undefined,
          targetHorizonDays:
            policy.method === "target-horizon" ? policy.horizonDays : undefined,
          constraint: "current-price",
          basis: "current-price",
          forecastStatus: "unavailable",
        }
      : undefined;
  }

  const constrained = applyConstraint?.(requestedPoint.price) ?? {
    price: requestedPoint.price,
    constraint: "none" as const,
  };
  const selectedPrice = roundCurrency(constrained.price);
  const minimumCurvePrice = Math.min(...curve.map(({ price }) => price));
  const maximumCurvePrice = Math.max(...curve.map(({ price }) => price));
  const finalPoint = pointAtPrice(curve, selectedPrice) ?? requestedPoint;
  const forecastStatus =
    finalPoint.supplyStatus !== "observed"
      ? "unavailable"
      : selectedPrice < minimumCurvePrice
        ? "lower-bound"
        : selectedPrice > maximumCurvePrice
          ? "upper-bound"
          : "interpolated";
  return {
    method: policy.method,
    selectedPrice,
    unconstrainedPrice: roundCurrency(requestedPoint.price),
    equivalentPercentile: finalPoint.percentile,
    configuredPercentile:
      policy.method === "percentile" ? policy.percentile : undefined,
    targetHorizonDays:
      policy.method === "target-horizon" ? policy.horizonDays : undefined,
    buyerIntervalDays: finalPoint.buyerIntervalDays,
    storeWinShare: finalPoint.storeWinShare,
    estimatedMedianSellDays: finalPoint.estimatedMedianSellDays,
    qualifyingSalesCount: finalPoint.qualifyingSalesCount,
    historyCapped: finalPoint.historyCapped,
    listingsCount: finalPoint.listingsCount,
    supplyStatus: finalPoint.supplyStatus,
    constraint: constrained.constraint,
    basis: "modeled",
    forecastStatus,
  };
}

export function readPricingDecision(
  details: PersistedDecisionLike | null | undefined,
): PricingDecision | undefined {
  if (!details) return undefined;
  if (
    details.decision &&
    details.pricingModelVersion === PRICING_MODEL_VERSION
  ) {
    return rehydrateStoredDecision(
      details,
      details.decision,
      details.marketplacePrice ?? details.decision.selectedPrice,
    );
  }
  if (details.percentileUsed === undefined) return undefined;
  const curve = toPricingCurve(details.percentiles);
  const point = pointAtPercentile(curve, details.percentileUsed);
  const unconstrainedPrice = details.suggestedPrice ?? point?.price;
  const selectedPrice = details.marketplacePrice ?? unconstrainedPrice;
  if (selectedPrice === undefined || selectedPrice <= 0) return undefined;
  const finalPoint = pointAtPrice(curve, selectedPrice);
  return {
    method: "percentile",
    selectedPrice,
    unconstrainedPrice,
    equivalentPercentile:
      finalPoint?.percentile ?? point?.percentile ?? details.percentileUsed,
    configuredPercentile: details.percentileUsed,
    buyerIntervalDays:
      finalPoint?.buyerIntervalDays ??
      point?.buyerIntervalDays ??
      details.historicalSalesVelocityDays,
    storeWinShare: finalPoint?.storeWinShare ?? point?.storeWinShare,
    estimatedMedianSellDays:
      finalPoint?.estimatedMedianSellDays ??
      point?.estimatedMedianSellDays ??
      details.estimatedTimeToSellDays,
    qualifyingSalesCount:
      finalPoint?.qualifyingSalesCount ?? point?.qualifyingSalesCount,
    historyCapped: finalPoint?.historyCapped ?? point?.historyCapped,
    listingsCount: finalPoint?.listingsCount ?? point?.listingsCount,
    supplyStatus: finalPoint?.supplyStatus ?? point?.supplyStatus,
    constraint:
      unconstrainedPrice !== undefined &&
      Math.abs(selectedPrice - unconstrainedPrice) >= 0.005
        ? "floor"
        : "none",
    basis: "legacy-unknown",
    forecastStatus: "unavailable",
  };
}

function rehydrateStoredDecision(
  details: PersistedDecisionLike,
  stored: PricingDecision,
  selectedPrice: number,
): PricingDecision {
  const unconstrainedPrice = stored.unconstrainedPrice ?? stored.selectedPrice;
  const finalPoint = pointAtPrice(
    toPricingCurve(details.percentiles),
    selectedPrice,
  );
  return {
    ...stored,
    selectedPrice,
    unconstrainedPrice,
    equivalentPercentile: finalPoint?.percentile ?? stored.equivalentPercentile,
    buyerIntervalDays:
      finalPoint?.buyerIntervalDays ?? stored.buyerIntervalDays,
    storeWinShare: finalPoint?.storeWinShare ?? stored.storeWinShare,
    estimatedMedianSellDays:
      finalPoint?.estimatedMedianSellDays ?? stored.estimatedMedianSellDays,
    qualifyingSalesCount:
      finalPoint?.qualifyingSalesCount ?? stored.qualifyingSalesCount,
    historyCapped: finalPoint?.historyCapped ?? stored.historyCapped,
    listingsCount: finalPoint?.listingsCount ?? stored.listingsCount,
    supplyStatus: finalPoint?.supplyStatus ?? stored.supplyStatus,
  };
}

export function readShadowPricingDecision(
  details: PersistedDecisionLike | null | undefined,
): PricingDecision | undefined {
  return details?.pricingModelVersion === PRICING_MODEL_VERSION &&
    details.shadowDecision
    ? rehydrateStoredDecision(
        details,
        details.shadowDecision,
        details.shadowDecision.selectedPrice,
      )
    : undefined;
}

function hashText(value: string): string {
  const hash = (seed: number): string => {
    let result = seed;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16).padStart(8, "0");
  };
  return `${hash(2166136261)}${hash(3335557771)}`;
}

function isObservedSellTime(
  point: PricingCurvePoint,
): point is PricingCurvePoint & { estimatedMedianSellDays: number } {
  return (
    point.supplyStatus === "observed" &&
    isPositive(point.estimatedMedianSellDays)
  );
}

function hasModeledCurve(item: PortfolioCurveItem): boolean {
  return item.curve.some(isObservedSellTime);
}

/**
 * Shortest and longest observed median sell time across the portfolio. Below
 * the minimum every SKU sits at its fastest curve point; above the maximum
 * every SKU sits at its slowest, so this is the range over which a target
 * horizon changes any price.
 */
export function observedHorizonRange(
  items: readonly PortfolioCurveItem[],
): { minimumDays: number; maximumDays: number } | undefined {
  let minimumDays = Number.POSITIVE_INFINITY;
  let maximumDays = 0;
  for (const item of items) {
    for (const point of item.curve) {
      if (!isObservedSellTime(point)) continue;
      minimumDays = Math.min(minimumDays, point.estimatedMedianSellDays);
      maximumDays = Math.max(maximumDays, point.estimatedMedianSellDays);
    }
  }
  if (maximumDays === 0) return undefined;
  return { minimumDays: Math.max(0.1, minimumDays), maximumDays };
}

function horizonBounds(items: readonly PortfolioCurveItem[]): [number, number] {
  const range = observedHorizonRange(items);
  return range ? [range.minimumDays, range.maximumDays] : [1, 365];
}

/** Horizons spaced evenly in log space from minimum to maximum, endpoints exact. */
export function logSpacedHorizons(
  minimumDays: number,
  maximumDays: number,
  count: number,
): number[] {
  const lastIndex = count - 1;
  return Array.from({ length: count }, (_, index) =>
    index === 0
      ? minimumDays
      : index === lastIndex
        ? maximumDays
        : minimumDays * (maximumDays / minimumDays) ** (index / lastIndex),
  );
}

export function decisionsAtHorizon(
  items: readonly PortfolioCurveItem[],
  horizonDays: number,
): Map<number, PricingDecision> {
  return new Map(
    items.flatMap((item) => {
      const decision = selectPricingDecision(
        item.curve,
        { method: "target-horizon", horizonDays },
        item.currentPrice,
        item.applyConstraint,
      );
      return decision ? [[item.sku, decision] as const] : [];
    }),
  );
}

function decisionValue(
  decisions: ReadonlyMap<number, PricingDecision>,
): number {
  return roundCurrency(
    [...decisions.values()].reduce(
      (sum, decision) => sum + decision.selectedPrice,
      0,
    ),
  );
}

interface HorizonCandidate {
  horizonDays: number;
  value: number;
  decisions: Map<number, PricingDecision>;
}

function findClosestHorizon(
  items: readonly PortfolioCurveItem[],
  baselineValue: number,
  minimumHorizon: number,
  maximumHorizon: number,
): {
  best: HorizonCandidate;
  minimumReachableValue: number;
  maximumReachableValue: number;
} {
  const evaluate = (horizonDays: number): HorizonCandidate => {
    const decisions = decisionsAtHorizon(items, horizonDays);
    return { horizonDays, decisions, value: decisionValue(decisions) };
  };
  const samples = logSpacedHorizons(
    minimumHorizon,
    maximumHorizon,
    SAMPLE_COUNT + 1,
  ).map(evaluate);
  let best = samples.reduce((closest, candidate) =>
    Math.abs(candidate.value - baselineValue) <
    Math.abs(closest.value - baselineValue)
      ? candidate
      : closest,
  );

  for (
    let index = 1;
    best.value !== baselineValue && index < samples.length;
    index += 1
  ) {
    let left = samples[index - 1];
    let right = samples[index];
    if ((left.value - baselineValue) * (right.value - baselineValue) >= 0)
      continue;
    for (let iteration = 0; iteration < REFINEMENT_ITERATIONS; iteration += 1) {
      const middle = evaluate(
        Math.exp(
          (Math.log(left.horizonDays) + Math.log(right.horizonDays)) / 2,
        ),
      );
      if (
        Math.abs(middle.value - baselineValue) <
        Math.abs(best.value - baselineValue)
      ) {
        best = middle;
      }
      if ((left.value - baselineValue) * (middle.value - baselineValue) <= 0)
        right = middle;
      else left = middle;
    }
  }

  return {
    best,
    minimumReachableValue: Math.min(...samples.map(({ value }) => value)),
    maximumReachableValue: Math.max(...samples.map(({ value }) => value)),
  };
}

export function resolveValueMatchedPortfolioPlan(
  items: readonly PortfolioCurveItem[],
  options: PortfolioPlanOptions = {},
): ResolvedPortfolioPricing {
  const seenSkus = new Set<number>();
  const duplicateSkus = new Set<number>();
  for (const item of items) {
    if (seenSkus.has(item.sku)) duplicateSkus.add(item.sku);
    seenSkus.add(item.sku);
  }
  if (duplicateSkus.size > 0) {
    throw new Error(
      `Portfolio pricing requires one row per SKU. Duplicates: ${[
        ...duplicateSkus,
      ].join(", ")}`,
    );
  }

  const createdAt = options.createdAt ?? new Date();
  const cohortId = options.cohortId ?? "unspecified";
  const baselineItems = items.filter(
    (item) =>
      item.currentPrice !== undefined &&
      Number.isFinite(item.currentPrice) &&
      item.currentPrice > 0,
  );
  const unavailableBaselineSkuCount = items.length - baselineItems.length;
  const modeledSkuCount = baselineItems.filter(hasModeledCurve).length;
  const baselineValue = roundCurrency(
    baselineItems.reduce((sum, item) => sum + item.currentPrice!, 0),
  );
  const [minimumHorizon, maximumHorizon] = horizonBounds(baselineItems);
  const closest = findClosestHorizon(
    baselineItems,
    baselineValue,
    minimumHorizon,
    maximumHorizon,
  );
  const valueTolerance = roundCurrency(Math.max(0.01, baselineValue * 0.0001));
  const valueDifference = roundCurrency(closest.best.value - baselineValue);
  const outsideReachableRange =
    baselineValue < closest.minimumReachableValue - valueTolerance ||
    baselineValue > closest.maximumReachableValue + valueTolerance;
  const matchStatus: PortfolioMatchStatus =
    modeledSkuCount === 0
      ? "infeasible"
      : Math.abs(valueDifference) <= valueTolerance
        ? "matched"
        : outsideReachableRange
          ? "boundary"
          : "infeasible";

  const snapshotText = baselineItems
    .map((item) =>
      JSON.stringify({
        sku: item.sku,
        currentPrice: roundCurrency(item.currentPrice!),
        constraintIdentity: item.constraintIdentity ?? "",
        curve: item.curve,
      }),
    )
    .sort()
    .join("|");
  const inventorySnapshotId = hashText(snapshotText);
  const planId = `shadow-${hashText(
    [
      PRICING_MODEL_VERSION,
      cohortId,
      inventorySnapshotId,
      createdAt.toISOString(),
      closest.best.horizonDays.toFixed(6),
    ].join("|"),
  )}`;
  const decisionsBySku = new Map(
    [...closest.best.decisions].map(([sku, decision]) => [
      sku,
      {
        ...decision,
        planId,
        targetHorizonDays: closest.best.horizonDays,
        planMatchStatus: matchStatus,
      },
    ]),
  );

  let raisedCount = 0;
  let loweredCount = 0;
  let heldCount = 0;
  let sparseDecisionCount = 0;
  let cappedHistoryCount = 0;
  for (const item of baselineItems) {
    const decision = decisionsBySku.get(item.sku);
    if (!decision) continue;
    const currentPrice = roundCurrency(item.currentPrice!);
    if (decision.selectedPrice > currentPrice) raisedCount += 1;
    else if (decision.selectedPrice < currentPrice) loweredCount += 1;
    else heldCount += 1;
    if (
      decision.basis === "modeled" &&
      (decision.qualifyingSalesCount === undefined ||
        decision.qualifyingSalesCount < 3)
    ) {
      sparseDecisionCount += 1;
    }
    if (decision.historyCapped) cappedHistoryCount += 1;
  }

  const plan: PortfolioPricingPlan = {
    id: planId,
    modelVersion: PRICING_MODEL_VERSION,
    createdAt: createdAt.toISOString(),
    baselineValue,
    selectedOneCopyValue: closest.best.value,
    valueDifference,
    valueTolerance,
    matchStatus,
    minimumReachableValue: closest.minimumReachableValue,
    maximumReachableValue: closest.maximumReachableValue,
    resolvedHorizonDays: closest.best.horizonDays,
    inventorySnapshotId,
    modeledSkuCount,
    unavailableBaselineSkuCount,
    raisedCount,
    loweredCount,
    heldCount,
    sparseDecisionCount,
    cappedHistoryCount,
  };

  return {
    plan,
    decisionsBySku,
  };
}
