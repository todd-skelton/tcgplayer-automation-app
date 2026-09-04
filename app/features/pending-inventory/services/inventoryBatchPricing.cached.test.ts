import assert from "node:assert/strict";
import type {
  PersistedPricingDetails,
  SuggestedPriceResolver,
} from "~/core/types/pricing";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import { PricingCalculator } from "~/features/pricing/services/pricingCalculator";
import { createCachedSuggestedPriceResolver } from "./inventoryBatchPricing.server";

const calculator = new PricingCalculator();
const skus = [1, 2, 3].map((sku) => ({
  sku,
  quantity: sku + 1,
  currentPrice: 20,
  productLineId: 1,
  setId: 2,
  productId: sku,
}));
const resolver: SuggestedPriceResolver = async () => ({
  suggestedPrice: 14,
  percentiles: [
    {
      percentile: 5,
      price: 10,
      historicalSalesVelocityMs: 8 * 86400000,
      storeWinShare: 0.8,
      salesCount: 20,
      listingsCount: 1,
      supplyStatus: "observed",
    },
    {
      percentile: 65,
      price: 14,
      historicalSalesVelocityMs: 20 * 86400000,
      storeWinShare: 0.5,
      salesCount: 10,
      listingsCount: 3,
      supplyStatus: "observed",
    },
    {
      percentile: 95,
      price: 30,
      historicalSalesVelocityMs: 40 * 86400000,
      storeWinShare: 0.2,
      salesCount: 2,
      listingsCount: 8,
      supplyStatus: "observed",
      historyCapped: true,
    },
  ],
  conditionNormalization: {
    method: "time-controlled-zipf",
    observationCount: 32,
    observedConditionCount: 3,
    conditionExponent: 0.6,
    conditionTimeConnected: true,
  },
});
const market = new Map(
  [1, 2].map((sku) => [
    sku,
    {
      skuId: sku,
      marketPrice: sku === 1 ? 10 : 20,
      lowestPrice: 9,
      highestPrice: 30,
      priceCount: 20,
      calculatedAt: "2026-09-02T12:00:00Z",
    },
  ]),
);
const baseline = await calculator.calculatePrices(
  skus,
  {
    percentile: 65,
    policy: { method: "target-horizon", horizonDays: 32 },
    suggestedPriceResolver: resolver,
  },
  market,
);
const saved = new Map(
  baseline.pricedItems.map((item): [number, PersistedPricingDetails] => [
    item.sku,
    {
      schemaVersion: 2,
      pricingModelVersion: PRICING_MODEL_VERSION,
      pricedAt: "2026-09-02T12:00:00Z",
      percentiles: item.percentiles,
      conditionNormalization: item.conditionNormalization,
    },
  ]),
);
const config = {
  percentile: 65,
  policy: { method: "target-horizon" as const, horizonDays: 24 },
};
const expected = await calculator.calculatePrices(
  skus,
  { ...config, suggestedPriceResolver: resolver },
  market,
);
const cached = await calculator.calculatePrices(
  skus,
  {
    ...config,
    suggestedPriceResolver: createCachedSuggestedPriceResolver(saved),
  },
  market,
);
assert.deepEqual(cached.pricedItems, expected.pricedItems);
assert.equal(cached.pricedItems[1]?.pricingDecision?.constraint, "floor");
assert.equal(
  cached.pricedItems[2]?.warnings?.[0],
  "No market price available. Using suggested price directly.",
);
assert.equal(
  cached.pricedItems[0]?.shadowPricingDecision?.method,
  "percentile",
);

const incompatible = createCachedSuggestedPriceResolver(
  new Map([
    [
      1,
      {
        ...saved.get(1)!,
        pricingModelVersion: "old-model",
      },
    ],
  ]),
);
assert.ok((await incompatible({ tcgplayerId: "1", percentile: 65 })).error);
assert.ok((await incompatible({ tcgplayerId: "99", percentile: 65 })).error);
console.log(
  "PASS saved curves reproduce fresh-data policy decisions, floors, and warnings",
);
