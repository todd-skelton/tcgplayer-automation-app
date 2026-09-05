import assert from "node:assert/strict";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
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
assert.equal(
  pokemon.estimatedMarketValue,
  25,
  "listed price stands in for SKUs without a market price",
);
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
        pricingModelVersion: PRICING_MODEL_VERSION,
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
        pricingModelVersion: PRICING_MODEL_VERSION,
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
        pricingModelVersion: PRICING_MODEL_VERSION,
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
assert.equal(
  completedInventoryDashboard.overall.policyComparisons.find(
    ({ key }) => key === "target-horizon-shadow",
  ),
  undefined,
  "no target-horizon row is resolved under another policy",
);

const activeHorizonItems = [
  item({
    sku: 20,
    currentPrice: 15,
    pricingDetails: {
      schemaVersion: 2,
      pricingModelVersion: PRICING_MODEL_VERSION,
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
      pricingModelVersion: PRICING_MODEL_VERSION,
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
];
const activeHorizonDashboard = buildInventoryStrategyDashboard(
  "seller",
  activeHorizonItems,
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
const profitPerDayBenchmark =
  activeHorizonDashboard.overall.policyComparisons.find(
    ({ key }) => key === "profit-per-day",
  );
assert.equal(profitPerDayBenchmark?.role, "benchmark");
assert.equal(profitPerDayBenchmark?.planState, "none");
assert.ok(
  profitPerDayBenchmark?.label.startsWith("Profit per day at 0.50%/day hurdle"),
  profitPerDayBenchmark?.label,
);
assert.equal(profitPerDayBenchmark?.modeledSkuCount, 2);
const activeProfitPerDayDashboard = buildInventoryStrategyDashboard(
  "seller",
  activeHorizonItems,
  {
    ...config,
    pricing: { ...config.pricing, policy: { method: "profit-per-day" } },
  },
);
const activeProfitPerDayRows = Object.fromEntries(
  activeProfitPerDayDashboard.overall.policyComparisons.map((comparison) => [
    comparison.key,
    comparison,
  ]),
);
assert.equal(activeProfitPerDayRows["profit-per-day"]?.role, "active");
assert.equal(
  activeProfitPerDayRows["profit-per-day"]?.label,
  "Profit per day at 0.50%/day hurdle",
);
assert.equal(
  activeProfitPerDayRows.percentile?.label,
  "Configured percentile (benchmark)",
);
assert.equal(activeProfitPerDayRows["target-horizon-shadow"], undefined);
assert.deepEqual(activeProfitPerDayDashboard.policy, {
  method: "profit-per-day",
});
const productLineHurdleDashboard = buildInventoryStrategyDashboard(
  "seller",
  [
    ...activeHorizonItems,
    item({
      sku: 30,
      productLineId: 5,
      productLine: "Magic",
      pricingDetails: {
        schemaVersion: 2,
        pricingModelVersion: PRICING_MODEL_VERSION,
        pricedAt: "2026-08-29T10:00:00.000Z",
        percentiles: [
          {
            percentile: 20,
            suggestedPrice: 10,
            estimatedTimeToSellDays: 10,
            supplyStatus: "observed",
          },
          {
            percentile: 90,
            suggestedPrice: 15,
            estimatedTimeToSellDays: 33.5,
            supplyStatus: "observed",
          },
        ],
      },
    }),
  ],
  {
    ...config,
    pricing: { ...config.pricing, policy: { method: "profit-per-day" } },
    productLinePricing: {
      ...config.productLinePricing,
      productLineSettings: {
        ...config.productLinePricing.productLineSettings,
        3: { percentile: 80, skip: false, dailyReturnHurdle: 0.05 },
      },
    },
  },
);
const profitPerDayLabel = (productLineId: number | null) =>
  (productLineId === null
    ? productLineHurdleDashboard.overall
    : productLineHurdleDashboard.productLines.find(
        (productLine) => productLine.productLineId === productLineId,
      )
  )?.policyComparisons.find(({ key }) => key === "profit-per-day")?.label;
assert.equal(profitPerDayLabel(3), "Profit per day at 5.00%/day hurdle");
assert.equal(profitPerDayLabel(5), "Profit per day at 0.50%/day hurdle");
assert.equal(profitPerDayLabel(null), "Profit per day at product-line hurdles");

const magicLine = productLineHurdleDashboard.productLines.find(
  (productLine) => productLine.productLineId === 5,
);
assert.ok(magicLine);
assert.deepEqual(
  magicLine.hurdleSweep.map((scenario) => scenario.dailyReturnHurdle),
  [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02],
  "the sweep covers the hurdle ladder",
);
const magicConfigured = magicLine.hurdleSweep.find(
  (scenario) => scenario.configured,
);
const magicComparison = magicLine.policyComparisons.find(
  ({ key }) => key === "profit-per-day",
);
assert.equal(magicConfigured?.dailyReturnHurdle, 0.005);
assert.deepEqual(
  {
    physicalValue: magicConfigured?.physicalValue,
    oneCopyValue: magicConfigured?.oneCopyValue,
    estimatedTime: magicConfigured?.estimatedTime,
    raisedCount: magicConfigured?.raisedCount,
  },
  {
    physicalValue: magicComparison?.physicalValue,
    oneCopyValue: magicComparison?.oneCopyValue,
    estimatedTime: magicComparison?.estimatedTime,
    raisedCount: magicComparison?.raisedCount,
  },
  "the configured hurdle's scenario matches the policy comparison row",
);
assert.ok(
  magicLine.hurdleSweep.every(
    (scenario, index, sweep) =>
      index === 0 || scenario.physicalValue <= sweep[index - 1].physicalValue,
  ),
  "a higher hurdle never lists for more",
);
const pokemonHurdleLine = productLineHurdleDashboard.productLines.find(
  (productLine) => productLine.productLineId === 3,
);
assert.equal(
  pokemonHurdleLine?.hurdleSweep.find((scenario) => scenario.configured)
    ?.dailyReturnHurdle,
  0.05,
  "a product-line hurdle outside the ladder joins the sweep as configured",
);
assert.equal(pokemonHurdleLine?.hurdleSweep.length, 7);
assert.equal(
  productLineHurdleDashboard.overall.hurdleSweep.find(
    (scenario) => scenario.configured,
  )?.dailyReturnHurdle,
  0.005,
  "all listed inventory marks the default hurdle",
);
assert.equal(activeHorizonComparison?.role, "active");
assert.equal(activeHorizonComparison?.oneCopyValue, 24);
assert.equal(activeHorizonComparison?.planState, "single");
assert.equal(percentileBenchmark?.role, "benchmark");
assert.equal(percentileBenchmark?.oneCopyValue, 24);

assert.equal(
  pokemon.horizonModel,
  null,
  "curves from an older pricing model do not produce a horizon model",
);
assert.equal(dashboard.policy.method, "percentile");

const completedHorizonCurve =
  completedInventoryDashboard.overall.horizonModel?.curve;
assert.ok(completedHorizonCurve);
assert.ok(
  completedHorizonCurve.floorValue < completedHorizonCurve.ceilingValue,
);
assert.deepEqual(activeHorizonDashboard.policy, {
  method: "target-horizon",
  horizonDays: 20,
});
const activeHorizonModel = activeHorizonDashboard.overall.horizonModel;
assert.ok(activeHorizonModel?.curve);
assert.equal(activeHorizonModel.minimumHorizonDays, 10);
assert.equal(activeHorizonModel.maximumHorizonDays, 33.5);
assert.equal(
  activeHorizonModel.curve.floorValue,
  40,
  "the floor is the exact value with every SKU at its fastest point",
);
assert.equal(
  activeHorizonModel.curve.ceilingValue,
  60,
  "the ceiling is the exact value with every SKU at its slowest point",
);
assert.ok(
  activeHorizonModel.curve.midpointDays > 10 &&
    activeHorizonModel.curve.midpointDays < 33.5,
  "the fitted midpoint falls inside the observed horizon range",
);
assert.notEqual(activeHorizonModel.fitConfidence, "unavailable");

console.log(
  "PASS inventory strategy preserves unmodeled value and applies guarded scenario prices",
);
