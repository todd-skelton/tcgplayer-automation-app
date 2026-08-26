import type { ServerPricingConfig } from "~/features/pricing/types/config";
import { calculateMarketplacePrice } from "~/features/pricing/services/pricingService";
import {
  INVENTORY_STRATEGY_PERCENTILES,
  type InventoryStrategyDashboard,
  type InventoryStrategyPercentile,
  type InventoryStrategyProductLine,
  type InventoryStrategyScenario,
  type InventoryStrategySnapshotItem,
  type InventoryStrategyTimeDistribution,
} from "../types/inventoryStrategy";

interface WeightedValue {
  value: number;
  weight: number;
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

function buildScenario(
  items: InventoryStrategySnapshotItem[],
  percentile: InventoryStrategyPercentile,
  currentListedValue: number,
): InventoryStrategyScenario {
  let listedValue = currentListedValue;
  let modeledSkuCount = 0;
  let modeledUnitCount = 0;
  let timeModeledUnitCount = 0;
  const timeValues: WeightedValue[] = [];

  for (const item of items) {
    const detail = item.pricingDetails?.percentiles?.find(
      (candidate) => candidate.percentile === percentile,
    );
    if (
      !detail ||
      !Number.isFinite(detail.suggestedPrice) ||
      detail.suggestedPrice <= 0
    ) {
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
    listedValue: roundCurrency(listedValue),
    deltaFromCurrentPolicy: 0,
    deltaPercentFromCurrentPolicy: null,
    modeledSkuCount,
    modeledUnitCount,
    timeModeledUnitCount,
    estimatedTime: summarizeTime(timeValues),
  };
}

function buildProductLine(
  key: string,
  productLineId: number | null,
  productLine: string,
  items: InventoryStrategySnapshotItem[],
  config: ServerPricingConfig,
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
  const scenarioPercentiles = new Set<number>(INVENTORY_STRATEGY_PERCENTILES);
  if (configuredPercentile !== null) {
    scenarioPercentiles.add(configuredPercentile);
  }
  const scenarios = [...scenarioPercentiles]
    .sort((left, right) => left - right)
    .map((percentile) => buildScenario(items, percentile, currentListedValue));
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

  return {
    key,
    productLineId,
    productLine,
    configuredPercentile,
    pricingEligible: items.some((item) => item.pricingEligible),
    skuCount: items.length,
    unitCount: items.reduce((sum, item) => sum + item.quantity, 0),
    currentListedValue,
    currentMarketValue,
    currentPolicyValue,
    modeledSkuCount: modeledItems.length,
    modeledUnitCount: modeledItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    ),
    oldestPricingAt: pricingDates[0]?.toISOString() ?? null,
    newestPricingAt: pricingDates.at(-1)?.toISOString() ?? null,
    scenarios,
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
