import type { ServerPricingConfig } from "~/features/pricing/types/config";
import { calculateMarketplacePrice } from "~/features/pricing/services/pricingService";
import {
  readPricingDecision,
  readShadowPricingDecision,
} from "~/features/pricing/domain/pricingPolicy";
import type { PricingPercentileDetail } from "~/core/types/pricing";
import {
  INVENTORY_STRATEGY_MAX_PERCENTILE,
  INVENTORY_STRATEGY_MIN_PERCENTILE,
  INVENTORY_STRATEGY_PERCENTILES,
  INVENTORY_STRATEGY_PREVIEW_PERCENTILES,
  type InventoryStrategyDashboard,
  type InventoryStrategyKneeConfidence,
  type InventoryStrategyPercentile,
  type InventoryStrategyPolicyComparison,
  type InventoryStrategyProductLine,
  type InventoryStrategyScenario,
  type InventoryStrategySnapshotItem,
  type InventoryStrategyTimeDistribution,
} from "../types/inventoryStrategy";

interface WeightedValue {
  value: number;
  weight: number;
}

interface KneeEstimate {
  mathematicalPercentile: number | null;
  estimatedPercentile: number | null;
  rangeMinimum: number | null;
  rangeMaximum: number | null;
  confidence: InventoryStrategyKneeConfidence;
}

const KNEE_SCORE_RANGE_TOLERANCE = 0.02;

interface ScenarioPricingDetail {
  suggestedPrice: number;
  estimatedTimeToSellDays?: number;
  interpolated: boolean;
}

interface ScenarioItem {
  item: InventoryStrategySnapshotItem;
  pricingDetails: PricingPercentileDetail[];
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function weightedQuantile(values: WeightedValue[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left.value - right.value);
  const totalWeight = ordered.reduce((sum, value) => sum + value.weight, 0);
  const targetWeight = totalWeight * quantile;
  let cumulativeWeight = 0;

  for (const value of ordered) {
    cumulativeWeight += value.weight;
    if (cumulativeWeight >= targetWeight) {
      return value.value;
    }
  }

  return ordered.at(-1)?.value ?? 0;
}

function summarizeTime(
  values: WeightedValue[],
): InventoryStrategyTimeDistribution | null {
  if (values.length === 0) {
    return null;
  }

  return {
    medianDays: weightedQuantile(values, 0.5),
    p75Days: weightedQuantile(values, 0.75),
    p90Days: weightedQuantile(values, 0.9),
  };
}

function getConfiguredPercentile(
  productLineId: number,
  config: ServerPricingConfig,
): number | null {
  const settings = config.productLinePricing.productLineSettings[productLineId];
  if (settings?.skip) {
    return null;
  }

  return settings?.percentile ?? config.productLinePricing.defaultPercentile;
}

function getScenarioPricingDetail(
  details: PricingPercentileDetail[],
  percentile: InventoryStrategyPercentile,
): ScenarioPricingDetail | null {
  const exact = details.find((detail) => detail.percentile === percentile);
  if (exact) {
    return {
      suggestedPrice: exact.suggestedPrice,
      estimatedTimeToSellDays: exact.estimatedTimeToSellDays,
      interpolated: false,
    };
  }

  const lower = [...details]
    .reverse()
    .find((detail) => detail.percentile < percentile);
  const upper = details.find((detail) => detail.percentile > percentile);
  if (!lower || !upper || lower.percentile === upper.percentile) {
    return null;
  }

  const position =
    (percentile - lower.percentile) / (upper.percentile - lower.percentile);
  const lowerTime = lower.estimatedTimeToSellDays;
  const upperTime = upper.estimatedTimeToSellDays;
  const canInterpolateTime =
    lowerTime !== undefined &&
    Number.isFinite(lowerTime) &&
    lowerTime >= 0 &&
    upperTime !== undefined &&
    Number.isFinite(upperTime) &&
    upperTime >= 0;

  return {
    suggestedPrice:
      lower.suggestedPrice +
      (upper.suggestedPrice - lower.suggestedPrice) * position,
    estimatedTimeToSellDays: canInterpolateTime
      ? lowerTime + (upperTime - lowerTime) * position
      : undefined,
    interpolated: true,
  };
}

function buildScenario(
  scenarioItems: ScenarioItem[],
  percentile: InventoryStrategyPercentile,
  currentListedValue: number,
): InventoryStrategyScenario {
  let listedValue = currentListedValue;
  let modeledSkuCount = 0;
  let modeledUnitCount = 0;
  let interpolatedSkuCount = 0;
  let interpolatedUnitCount = 0;
  let timeModeledUnitCount = 0;
  const timeValues: WeightedValue[] = [];

  for (const { item, pricingDetails } of scenarioItems) {
    const detail = getScenarioPricingDetail(pricingDetails, percentile);
    if (!detail) {
      continue;
    }

    const boundedPrice = roundCurrency(
      calculateMarketplacePrice(
        detail.suggestedPrice,
        item.marketPrice === null ? null : { marketPrice: item.marketPrice },
      ).marketplacePrice,
    );
    const currentValue = (item.currentPrice ?? 0) * item.quantity;
    listedValue += boundedPrice * item.quantity - currentValue;
    modeledSkuCount += 1;
    modeledUnitCount += item.quantity;
    if (detail.interpolated) {
      interpolatedSkuCount += 1;
      interpolatedUnitCount += item.quantity;
    }

    if (
      detail.estimatedTimeToSellDays !== undefined &&
      Number.isFinite(detail.estimatedTimeToSellDays) &&
      detail.estimatedTimeToSellDays >= 0
    ) {
      timeValues.push({
        value: detail.estimatedTimeToSellDays,
        weight: item.quantity,
      });
      timeModeledUnitCount += item.quantity;
    }
  }

  return {
    percentile,
    kneeScore: null,
    listedValue: roundCurrency(listedValue),
    deltaFromCurrentPolicy: 0,
    deltaPercentFromCurrentPolicy: null,
    modeledSkuCount,
    modeledUnitCount,
    interpolatedSkuCount,
    interpolatedUnitCount,
    timeModeledUnitCount,
    estimatedTime: summarizeTime(timeValues),
  };
}

function buildPolicyComparisons(
  items: InventoryStrategySnapshotItem[],
): InventoryStrategyPolicyComparison[] {
  const build = (
    key: InventoryStrategyPolicyComparison["key"],
  ): InventoryStrategyPolicyComparison | null => {
    const isCurrent = key === "current";
    const decisions = items.map((item) => ({
      item,
      decision:
        key === "percentile"
          ? readPricingDecision(item.pricingDetails)
          : key === "target-horizon-shadow"
            ? readShadowPricingDecision(item.pricingDetails)
            : undefined,
    }));
    if (!isCurrent && !decisions.some(({ decision }) => decision)) return null;

    let oneCopyValue = 0;
    let physicalValue = 0;
    let modeledSkuCount = 0;
    let raisedCount = 0;
    let loweredCount = 0;
    let heldCount = 0;
    const timeValues: WeightedValue[] = [];
    const targetHorizons = new Set<number>();
    const planIds = new Set<string>();
    const planMatchStatuses = new Set<
      "matched" | "boundary" | "infeasible"
    >();

    for (const { item, decision } of decisions) {
      const currentPrice = item.currentPrice ?? 0;
      const selectedPrice =
        key === "percentile"
          ? (item.pricingDetails?.marketplacePrice ??
            decision?.selectedPrice ??
            currentPrice)
          : (decision?.selectedPrice ?? currentPrice);
      oneCopyValue += selectedPrice;
      physicalValue += selectedPrice * item.quantity;
      if (decision) {
        const isModeledDecision =
          decision.basis === "modeled" &&
          decision.forecastStatus !== "unavailable";
        if (isModeledDecision) modeledSkuCount += 1;
        if (selectedPrice > currentPrice) raisedCount += 1;
        else if (selectedPrice < currentPrice) loweredCount += 1;
        else heldCount += 1;
        if (
          isModeledDecision &&
          decision.estimatedMedianSellDays !== undefined
        ) {
          timeValues.push({
            value: decision.estimatedMedianSellDays,
            weight: item.quantity,
          });
        }
        if (decision.targetHorizonDays !== undefined)
          targetHorizons.add(decision.targetHorizonDays);
        if (decision.planId) planIds.add(decision.planId);
        if (decision.planMatchStatus)
          planMatchStatuses.add(decision.planMatchStatus);
      } else {
        heldCount += 1;
      }
    }

    return {
      key,
      label:
        key === "current"
          ? "Current listed prices"
          : key === "percentile"
            ? "Configured percentile"
            : "Value-matched horizon (shadow)",
      planState:
        planIds.size > 1 || targetHorizons.size > 1
          ? "mixed"
          : planIds.size === 1
            ? "single"
            : "none",
      matchStatus:
        planIds.size > 1 ||
        targetHorizons.size > 1 ||
        planMatchStatuses.size > 1
          ? "mixed"
          : planMatchStatuses.size === 1
            ? [...planMatchStatuses][0]
            : null,
      oneCopyValue: roundCurrency(oneCopyValue),
      physicalValue: roundCurrency(physicalValue),
      modeledSkuCount,
      raisedCount,
      loweredCount,
      heldCount,
      estimatedTime: summarizeTime(timeValues),
    };
  };

  return (["current", "percentile", "target-horizon-shadow"] as const)
    .map(build)
    .filter(
      (comparison): comparison is InventoryStrategyPolicyComparison =>
        comparison !== null,
    );
}

function estimateKnee(
  scenarios: InventoryStrategyScenario[],
  configuredPercentile: number | null,
  totalUnitCount: number,
  exactCandidatePercentiles: ReadonlySet<number>,
): KneeEstimate {
  const scoredScenarios = scenarios.filter(
    (scenario) =>
      scenario.estimatedTime !== null && scenario.modeledUnitCount > 0,
  );
  const candidates = scoredScenarios.filter((scenario) =>
    exactCandidatePercentiles.has(scenario.percentile),
  );
  if (candidates.length < 3) {
    return {
      mathematicalPercentile: null,
      estimatedPercentile: null,
      rangeMinimum: null,
      rangeMaximum: null,
      confidence: "unavailable",
    };
  }

  const values = scoredScenarios.map((scenario) => scenario.listedValue);
  const times = scoredScenarios.map(
    (scenario) => scenario.estimatedTime?.medianDays ?? 0,
  );
  const minimumValue = Math.min(...values);
  const maximumValue = Math.max(...values);
  const minimumTime = Math.min(...times);
  const maximumTime = Math.max(...times);
  const valueRange = maximumValue - minimumValue;
  const timeRange = maximumTime - minimumTime;
  if (valueRange <= 0 || timeRange <= 0) {
    return {
      mathematicalPercentile: null,
      estimatedPercentile: null,
      rangeMinimum: null,
      rangeMaximum: null,
      confidence: "unavailable",
    };
  }

  for (const scenario of scoredScenarios) {
    const normalizedValue = (scenario.listedValue - minimumValue) / valueRange;
    const normalizedTime =
      ((scenario.estimatedTime?.medianDays ?? minimumTime) - minimumTime) /
      timeRange;
    scenario.kneeScore = normalizedValue - normalizedTime;
  }

  const mathematical = [...candidates].sort(
    (left, right) =>
      (right.kneeScore ?? Number.NEGATIVE_INFINITY) -
        (left.kneeScore ?? Number.NEGATIVE_INFINITY) ||
      left.percentile - right.percentile,
  )[0];
  const maximumScore = mathematical.kneeScore ?? 0;
  const range = candidates.filter(
    (scenario) =>
      scenario.kneeScore !== null &&
      scenario.kneeScore >= maximumScore - KNEE_SCORE_RANGE_TOLERANCE,
  );
  const configuredCandidate = range.find(
    (scenario) => scenario.percentile === configuredPercentile,
  );
  const coverage =
    totalUnitCount === 0 ? 0 : mathematical.modeledUnitCount / totalUnitCount;
  const confidence: InventoryStrategyKneeConfidence =
    coverage < 0.8
      ? "low"
      : range.length === 1 && candidates.length >= 5
        ? "high"
        : "medium";

  return {
    mathematicalPercentile: mathematical.percentile,
    estimatedPercentile:
      configuredCandidate?.percentile ?? mathematical.percentile,
    rangeMinimum: Math.min(...range.map((scenario) => scenario.percentile)),
    rangeMaximum: Math.max(...range.map((scenario) => scenario.percentile)),
    confidence,
  };
}

function buildProductLine(
  key: string,
  productLineId: number | null,
  productLine: string,
  items: InventoryStrategySnapshotItem[],
  config: ServerPricingConfig,
  additionalPercentiles: readonly number[] = [],
): InventoryStrategyProductLine {
  const configuredPercentile =
    productLineId === null
      ? null
      : getConfiguredPercentile(productLineId, config);
  const currentListedValue = roundCurrency(
    items.reduce(
      (sum, item) => sum + (item.currentPrice ?? 0) * item.quantity,
      0,
    ),
  );
  const currentMarketValue = roundCurrency(
    items.reduce(
      (sum, item) => sum + (item.marketPrice ?? 0) * item.quantity,
      0,
    ),
  );
  const exactCandidatePercentiles = new Set<number>(
    INVENTORY_STRATEGY_PERCENTILES,
  );
  for (const item of items) {
    for (const detail of item.pricingDetails?.percentiles ?? []) {
      if (
        Number.isFinite(detail.percentile) &&
        detail.percentile >= 0 &&
        detail.percentile <= 100
      ) {
        exactCandidatePercentiles.add(detail.percentile);
      }
    }
  }
  for (const percentile of additionalPercentiles) {
    exactCandidatePercentiles.add(percentile);
  }
  if (configuredPercentile !== null) {
    exactCandidatePercentiles.add(configuredPercentile);
  }
  const scenarioPercentiles = new Set<number>(
    INVENTORY_STRATEGY_PREVIEW_PERCENTILES,
  );
  for (const percentile of exactCandidatePercentiles) {
    if (
      percentile >= INVENTORY_STRATEGY_MIN_PERCENTILE &&
      percentile <= INVENTORY_STRATEGY_MAX_PERCENTILE
    ) {
      scenarioPercentiles.add(percentile);
    }
  }
  const scenarioItems = items.map((item) => ({
    item,
    pricingDetails: (item.pricingDetails?.percentiles ?? [])
      .filter(
        (detail) =>
          Number.isFinite(detail.percentile) &&
          Number.isFinite(detail.suggestedPrice) &&
          detail.suggestedPrice > 0,
      )
      .sort((left, right) => left.percentile - right.percentile),
  }));
  const scenarios = [...scenarioPercentiles]
    .sort((left, right) => left - right)
    .map((percentile) =>
      buildScenario(scenarioItems, percentile, currentListedValue),
    );
  const configuredScenario = scenarios.find(
    (scenario) => scenario.percentile === configuredPercentile,
  );
  const currentPolicyValue =
    configuredScenario?.listedValue ?? currentListedValue;

  for (const scenario of scenarios) {
    scenario.deltaFromCurrentPolicy = roundCurrency(
      scenario.listedValue - currentPolicyValue,
    );
    scenario.deltaPercentFromCurrentPolicy =
      currentPolicyValue === 0
        ? null
        : (scenario.deltaFromCurrentPolicy / currentPolicyValue) * 100;
  }

  const modeledItems = items.filter(
    (item) => (item.pricingDetails?.percentiles?.length ?? 0) > 0,
  );
  const pricingDates = modeledItems
    .map((item) => item.strategyPricedAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  const unitCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const knee = estimateKnee(
    scenarios,
    configuredPercentile,
    unitCount,
    exactCandidatePercentiles,
  );

  return {
    key,
    productLineId,
    productLine,
    configuredPercentile,
    pricingEligible: items.some((item) => item.pricingEligible),
    skuCount: items.length,
    unitCount,
    currentListedValue,
    currentMarketValue,
    currentPolicyValue,
    mathematicalKneePercentile: knee.mathematicalPercentile,
    estimatedPercentile: knee.estimatedPercentile,
    kneeRangeMinimum: knee.rangeMinimum,
    kneeRangeMaximum: knee.rangeMaximum,
    kneeConfidence: knee.confidence,
    modeledSkuCount: modeledItems.length,
    modeledUnitCount: modeledItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    ),
    oldestPricingAt: pricingDates[0]?.toISOString() ?? null,
    newestPricingAt: pricingDates.at(-1)?.toISOString() ?? null,
    matrixPercentiles: [...exactCandidatePercentiles]
      .filter(
        (percentile) =>
          percentile >= INVENTORY_STRATEGY_MIN_PERCENTILE &&
          percentile <= INVENTORY_STRATEGY_MAX_PERCENTILE,
      )
      .sort((left, right) => left - right),
    scenarios,
    policyComparisons: buildPolicyComparisons(items),
  };
}

export function buildInventoryStrategyDashboard(
  sellerKey: string,
  items: InventoryStrategySnapshotItem[],
  config: ServerPricingConfig,
  generatedAt = new Date(),
): InventoryStrategyDashboard {
  const productLineGroups = new Map<
    string,
    {
      productLineId: number;
      productLine: string;
      items: InventoryStrategySnapshotItem[];
    }
  >();

  for (const item of items) {
    const key = String(item.productLineId);
    const group = productLineGroups.get(key) ?? {
      productLineId: item.productLineId,
      productLine: item.productLine,
      items: [],
    };
    group.items.push(item);
    productLineGroups.set(key, group);
  }

  const productLines = [...productLineGroups.entries()]
    .map(([key, group]) =>
      buildProductLine(
        key,
        group.productLineId,
        group.productLine,
        group.items,
        config,
      ),
    )
    .sort((left, right) => left.productLine.localeCompare(right.productLine));
  const overall = buildProductLine(
    "all",
    null,
    "All listed inventory",
    items,
    config,
    [
      config.productLinePricing.defaultPercentile,
      ...Object.values(config.productLinePricing.productLineSettings)
        .filter((settings) => !settings.skip)
        .map((settings) => settings.percentile),
    ],
  );
  overall.currentPolicyValue = roundCurrency(
    productLines.reduce(
      (sum, productLine) => sum + productLine.currentPolicyValue,
      0,
    ),
  );
  for (const scenario of overall.scenarios) {
    scenario.deltaFromCurrentPolicy = roundCurrency(
      scenario.listedValue - overall.currentPolicyValue,
    );
    scenario.deltaPercentFromCurrentPolicy =
      overall.currentPolicyValue === 0
        ? null
        : (scenario.deltaFromCurrentPolicy / overall.currentPolicyValue) * 100;
  }

  return {
    sellerKey,
    generatedAt: generatedAt.toISOString(),
    overall,
    productLines,
  };
}
