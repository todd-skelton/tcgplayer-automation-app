import assert from "node:assert/strict";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import type { InventoryStrategySnapshotItem } from "../types/inventoryStrategy";
import { buildInventoryStrategyDashboard } from "./inventoryStrategy";

function item(
  overrides: Partial<InventoryStrategySnapshotItem>,
): InventoryStrategySnapshotItem {
  return {
    sellerKey: "seller",
    sku: 1,
    productId: 10,
    productLineId: 3,
    setId: 20,
    productLine: "Pokemon",
    setName: "Set",
    productName: "Card",
    condition: "Near Mint",
    variant: "Normal",
    quantity: 2,
    currentPrice: 12,
    marketPrice: 10,
    pricingEligible: true,
    pricingDetails: {
      schemaVersion: 1,
      pricedAt: "2026-08-26T10:00:00.000Z",
      percentiles: [
        {
          percentile: 50,
          suggestedPrice: 8,
          estimatedTimeToSellDays: 4,
        },
        {
          percentile: 70,
          suggestedPrice: 11,
          estimatedTimeToSellDays: 8,
        },
        {
          percentile: 75,
          suggestedPrice: 12,
          estimatedTimeToSellDays: 11,
        },
        {
          percentile: 80,
          suggestedPrice: 14,
          estimatedTimeToSellDays: 20,
        },
      ],
    },
    strategyPricedAt: new Date("2026-08-26T10:00:00.000Z"),
    ...overrides,
  };
}

const config = {
  ...DEFAULT_SERVER_PRICING_CONFIG,
  productLinePricing: {
    defaultPercentile: 65,
    productLineSettings: {
      3: { percentile: 80, skip: false },
      4: { percentile: 80, skip: true },
    },
  },
};

const dashboard = buildInventoryStrategyDashboard(
  "seller",
  [
    item({}),
    item({
      sku: 2,
      quantity: 1,
      currentPrice: 5,
      marketPrice: null,
      pricingDetails: null,
      strategyPricedAt: null,
    }),
    item({
      sku: 3,
      productLineId: 4,
      productLine: "Magic",
      quantity: 1,
      currentPrice: 20,
      marketPrice: 18,
      pricingEligible: false,
      pricingDetails: null,
      strategyPricedAt: null,
    }),
  ],
  config,
  new Date("2026-08-26T12:00:00.000Z"),
);

const pokemon = dashboard.productLines.find(
  (productLine) => productLine.productLine === "Pokemon",
);
assert.ok(pokemon);
assert.equal(pokemon.currentListedValue, 29);
assert.equal(pokemon.currentPolicyValue, 33);
assert.equal(pokemon.modeledSkuCount, 1);
assert.equal(pokemon.modeledUnitCount, 2);

const fiftieth = pokemon.scenarios.find(
  (scenario) => scenario.percentile === 50,
);
assert.ok(fiftieth);
assert.equal(fiftieth.listedValue, 23.62);
assert.equal(fiftieth.deltaFromCurrentPolicy, -9.38);
assert.equal(fiftieth.estimatedTime?.medianDays, 4);
assert.equal(fiftieth.modeledUnitCount, 2);

const seventyFifth = pokemon.scenarios.find(
  (scenario) => scenario.percentile === 75,
);
assert.ok(seventyFifth);
assert.equal(seventyFifth.interpolatedSkuCount, 0);
assert.equal(seventyFifth.interpolatedUnitCount, 0);
assert.ok(
  (seventyFifth.kneeScore ?? 0) >
    (pokemon.scenarios.find((scenario) => scenario.percentile === 70)
      ?.kneeScore ?? 0),
);
assert.equal(pokemon.mathematicalKneePercentile, 75);
assert.equal(pokemon.estimatedPercentile, 75);
assert.equal(pokemon.kneeRangeMinimum, 75);
assert.equal(pokemon.kneeRangeMaximum, 75);
assert.equal(pokemon.kneeConfidence, "low");

const seventyThird = pokemon.scenarios.find(
  (scenario) => scenario.percentile === 73,
);
assert.ok(seventyThird);
assert.equal(seventyThird.listedValue, 28.2);
assert.equal(seventyThird.estimatedTime?.medianDays, 9.8);
assert.equal(seventyThird.interpolatedSkuCount, 1);
assert.equal(seventyThird.interpolatedUnitCount, 2);
assert.equal(pokemon.scenarios.length, 91);
assert.deepEqual(
  pokemon.matrixPercentiles,
  Array.from({ length: 19 }, (_, index) => 5 + index * 5),
);

const magic = dashboard.productLines.find(
  (productLine) => productLine.productLine === "Magic",
);
assert.ok(magic);
assert.equal(magic.configuredPercentile, null);
assert.equal(magic.currentPolicyValue, 20);
assert.equal(magic.pricingEligible, false);

assert.equal(dashboard.overall.currentListedValue, 49);
assert.equal(dashboard.overall.currentPolicyValue, 53);
assert.equal(dashboard.overall.modeledUnitCount, 2);
assert.equal(dashboard.generatedAt, "2026-08-26T12:00:00.000Z");

const completedInventoryDashboard = buildInventoryStrategyDashboard(
  "seller",
  [
    item({
      sku: 10,
      pricingDetails: {
        schemaVersion: 2,
        pricingModelVersion: "exposure-share-v1",
        pricedAt: "2026-08-30T10:00:00.000Z",
        percentileUsed: 80,
        marketplacePrice: 16,
        percentiles: [
          {
            percentile: 20,
            suggestedPrice: 8,
            historicalSalesVelocityDays: 2,
            estimatedTimeToSellDays: 2.77,
            storeWinShare: 0.5,
            supplyStatus: "observed",
          },
          {
            percentile: 80,
            suggestedPrice: 16,
            historicalSalesVelocityDays: 30,
            estimatedTimeToSellDays: 41.59,
            storeWinShare: 0.5,
            supplyStatus: "observed",
          },
        ],
        shadowDecision: {
          method: "target-horizon",
          selectedPrice: 12,
          targetHorizonDays: 40,
          estimatedMedianSellDays: 40,
          constraint: "none",
          basis: "modeled",
          forecastStatus: "interpolated",
          planId: "plan-a",
        },
      },
    }),
    item({
      sku: 11,
      pricingDetails: {
        schemaVersion: 2,
        pricingModelVersion: "exposure-share-v1",
        pricedAt: "2026-08-30T10:00:00.000Z",
        percentileUsed: 80,
        marketplacePrice: 17,
        percentiles: [
          {
            percentile: 20,
            suggestedPrice: 9,
            historicalSalesVelocityDays: 3,
            estimatedTimeToSellDays: 4.16,
            storeWinShare: 0.5,
            supplyStatus: "observed",
          },
          {
            percentile: 80,
            suggestedPrice: 17,
            historicalSalesVelocityDays: 40,
            estimatedTimeToSellDays: 55.45,
            storeWinShare: 0.5,
            supplyStatus: "observed",
          },
        ],
        shadowDecision: {
          method: "target-horizon",
          selectedPrice: 13,
          targetHorizonDays: 55,
          estimatedMedianSellDays: 55,
          constraint: "none",
          basis: "modeled",
          forecastStatus: "interpolated",
          planId: "plan-b",
        },
      },
    }),
    item({
      sku: 12,
      pricingDetails: {
        schemaVersion: 2,
        pricingModelVersion: "exposure-share-v1",
        pricedAt: "2026-08-30T10:00:00.000Z",
        shadowDecision: {
          method: "target-horizon",
          selectedPrice: 12,
          targetHorizonDays: 40,
          estimatedMedianSellDays: 999,
          constraint: "current-price",
          basis: "current-price",
          forecastStatus: "unavailable",
          planId: "plan-a",
        },
      },
    }),
  ],
  config,
);
const completedComparison =
  completedInventoryDashboard.overall.policyComparisons.find(
    ({ key }) => key === "target-horizon-shadow",
  );
assert.equal(
  completedComparison?.planState,
  "single",
  "the dashboard resolves one plan from complete inventory curves",
);
assert.equal(completedComparison?.modeledSkuCount, 2);
assert.ok(completedComparison?.estimatedTime);
assert.ok(
  Math.abs((completedComparison?.oneCopyValue ?? 0) - 36) <= 0.02,
  "the inventory-wide shadow plan matches current one-copy value",
);

const activeHorizonDashboard = buildInventoryStrategyDashboard(
  "seller",
  [
    item({
      sku: 20,
      currentPrice: 15,
      pricingDetails: {
        schemaVersion: 2,
        pricingModelVersion: "exposure-share-v1",
        pricedAt: "2026-08-30T10:00:00.000Z",
        percentileUsed: 65,
        marketplacePrice: 15,
        percentiles: [
          {
            percentile: 20,
            suggestedPrice: 10,
            estimatedTimeToSellDays: 10,
            supplyStatus: "observed",
          },
          {
            percentile: 65,
            suggestedPrice: 12,
            estimatedTimeToSellDays: 20,
            supplyStatus: "observed",
          },
          {
            percentile: 90,
            suggestedPrice: 15,
            estimatedTimeToSellDays: 33.5,
            supplyStatus: "observed",
          },
        ],
        policy: { method: "target-horizon", horizonDays: 33.5 },
        decision: {
          method: "target-horizon",
          selectedPrice: 15,
          targetHorizonDays: 33.5,
          estimatedMedianSellDays: 33.5,
          constraint: "none",
          basis: "modeled",
          forecastStatus: "interpolated",
        },
        shadowDecision: {
          method: "percentile",
          selectedPrice: 12,
          configuredPercentile: 65,
          estimatedMedianSellDays: 20,
          constraint: "none",
          basis: "modeled",
          forecastStatus: "interpolated",
        },
      },
    }),
    item({
      sku: 21,
      currentPrice: 12,
      pricingDetails: {
        schemaVersion: 2,
        pricingModelVersion: "exposure-share-v1",
        pricedAt: "2026-08-29T10:00:00.000Z",
        percentileUsed: 65,
        marketplacePrice: 12,
        percentiles: [
          {
            percentile: 20,
            suggestedPrice: 10,
            estimatedTimeToSellDays: 10,
            supplyStatus: "observed",
          },
          {
            percentile: 65,
            suggestedPrice: 12,
            estimatedTimeToSellDays: 20,
            supplyStatus: "observed",
          },
          {
            percentile: 90,
            suggestedPrice: 15,
            estimatedTimeToSellDays: 33.5,
            supplyStatus: "observed",
          },
        ],
        policy: { method: "percentile", percentile: 65 },
        decision: {
          method: "percentile",
          selectedPrice: 12,
          configuredPercentile: 65,
          estimatedMedianSellDays: 20,
          constraint: "none",
          basis: "modeled",
          forecastStatus: "interpolated",
        },
      },
    }),
  ],
  {
    ...config,
    pricing: {
      ...config.pricing,
      policy: { method: "target-horizon", horizonDays: 20 },
    },
  },
);
const activeHorizonComparison =
  activeHorizonDashboard.overall.policyComparisons.find(
    ({ key }) => key === "target-horizon-shadow",
  );
const percentileBenchmark =
  activeHorizonDashboard.overall.policyComparisons.find(
    ({ key }) => key === "percentile",
  );
assert.equal(activeHorizonComparison?.role, "active");
assert.equal(activeHorizonComparison?.oneCopyValue, 24);
assert.equal(activeHorizonComparison?.planState, "single");
assert.equal(percentileBenchmark?.role, "benchmark");
assert.equal(percentileBenchmark?.oneCopyValue, 24);

console.log(
  "PASS inventory strategy preserves unmodeled value and applies guarded scenario prices",
);
