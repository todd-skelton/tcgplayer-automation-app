import assert from "node:assert/strict";
import { PricingCalculator } from "./pricingCalculator";

const calculator = new PricingCalculator();
const result = await calculator.calculatePrices(
  [
    {
      sku: 123,
      quantity: 1,
      currentPrice: 20,
      productLineId: 1,
      setId: 2,
      productId: 3,
    },
  ],
  {
    percentile: 65,
    suggestedPriceResolver: async () => ({
      suggestedPrice: null,
      lowestListingPrice: 12.34,
    }),
  },
  new Map([
    [
      123,
      {
        skuId: 123,
        marketPrice: 10,
        lowestPrice: 9,
        highestPrice: 11,
        priceCount: 1,
        calculatedAt: "2026-08-18T12:00:00.000Z",
      },
    ],
  ]),
);

assert.equal(result.pricedItems[0]?.price, 12.34);
assert.equal(result.pricedItems[0]?.errors?.length, 0);
assert.equal(result.pricedItems[0]?.warnings?.length, 1);
assert.equal(result.stats.processed, 1);
assert.equal(result.stats.errors, 0);
assert.equal(result.stats.warnings, 1);
assert.equal(result.pricedItems[0]?.pricingDecision?.selectedPrice, 12.34);
assert.equal(
  result.pricedItems[0]?.pricingDecision?.basis,
  "market-and-listing-reference",
);
assert.equal(result.pricedItems[0]?.pricingDecision?.constraint, "none");

console.log(
  "PASS insufficient-sales fallbacks are warning-only priced results",
);

const shadowResult = await calculator.calculatePrices(
  [
    {
      sku: 456,
      quantity: 8,
      currentPrice: 20,
      productLineId: 1,
      setId: 2,
      productId: 3,
    },
  ],
  {
    percentile: 65,
    suggestedPriceResolver: async () => ({
      suggestedPrice: 14,
      percentiles: [
        {
          percentile: 5,
          price: 10,
          historicalSalesVelocityMs: 10 * 24 * 60 * 60 * 1000,
          estimatedTimeToSellMs: 10 * 24 * 60 * 60 * 1000,
          salesCount: 10,
          supplyStatus: "observed",
        },
        {
          percentile: 65,
          price: 14,
          historicalSalesVelocityMs: 30 * 24 * 60 * 60 * 1000,
          estimatedTimeToSellMs: 30 * 24 * 60 * 60 * 1000,
          salesCount: 6,
          supplyStatus: "observed",
        },
        {
          percentile: 95,
          price: 30,
          historicalSalesVelocityMs: 100 * 24 * 60 * 60 * 1000,
          estimatedTimeToSellMs: 100 * 24 * 60 * 60 * 1000,
          salesCount: 2,
          supplyStatus: "observed",
        },
      ],
    }),
  },
);

assert.equal(shadowResult.pricedItems[0]?.suggestedPrice, 14);
assert.equal(shadowResult.pricedItems[0]?.price, 14);
assert.equal(
  shadowResult.pricedItems[0]?.pricingDecision?.method,
  "percentile",
);
assert.equal(
  shadowResult.pricedItems[0]?.shadowPricingDecision?.method,
  "target-horizon",
);
assert.equal(
  shadowResult.pricedItems[0]?.shadowPricingDecision?.selectedPrice,
  20,
);
assert.equal(shadowResult.shadowPortfolioPlan?.baselineValue, 20);

console.log("PASS shadow horizon cannot replace the active percentile price");

const targetHorizonResult = await calculator.calculatePrices(
  [
    {
      sku: 457,
      quantity: 1,
      currentPrice: 20,
      productLineId: 1,
      setId: 2,
      productId: 3,
    },
  ],
  {
    percentile: 65,
    policy: { method: "target-horizon", horizonDays: 20 },
    suggestedPriceResolver: async () => ({
      suggestedPrice: 14,
      percentiles: [
        {
          percentile: 5,
          price: 10,
          estimatedTimeToSellMs: 10 * 24 * 60 * 60 * 1000,
          supplyStatus: "observed",
        },
        {
          percentile: 65,
          price: 14,
          estimatedTimeToSellMs: 30 * 24 * 60 * 60 * 1000,
          supplyStatus: "observed",
        },
      ],
    }),
  },
);

assert.equal(targetHorizonResult.pricedItems[0]?.price, 12);
assert.equal(
  targetHorizonResult.pricedItems[0]?.pricingDecision?.method,
  "target-horizon",
);
assert.equal(
  targetHorizonResult.pricedItems[0]?.pricingDecision?.targetHorizonDays,
  20,
);
assert.equal(
  targetHorizonResult.pricedItems[0]?.shadowPricingDecision?.method,
  "percentile",
);
assert.equal(
  targetHorizonResult.pricedItems[0]?.shadowPricingDecision?.selectedPrice,
  14,
);
assert.equal(targetHorizonResult.shadowPortfolioPlan, undefined);

console.log(
  "PASS fixed target horizon becomes active with percentile benchmark",
);

const targetUnavailableResult = await calculator.calculatePrices(
  [
    {
      sku: 458,
      quantity: 1,
      currentPrice: 20,
      productLineId: 1,
      setId: 2,
      productId: 3,
    },
  ],
  {
    percentile: 65,
    policy: { method: "target-horizon", horizonDays: 20 },
    suggestedPriceResolver: async () => ({
      suggestedPrice: 14,
      percentiles: [
        {
          percentile: 65,
          price: 14,
          estimatedTimeToSellMs: 30 * 24 * 60 * 60 * 1000,
          supplyStatus: "unavailable",
        },
      ],
    }),
  },
);

assert.equal(targetUnavailableResult.pricedItems[0]?.price, 20);
assert.equal(
  targetUnavailableResult.pricedItems[0]?.pricingDecision?.basis,
  "current-price",
);
assert.equal(
  targetUnavailableResult.pricedItems[0]?.pricingDecision?.method,
  "target-horizon",
);

console.log(
  "PASS target horizon keeps current price when forecasting is unavailable",
);

const twoPointResolver = async () => ({
  suggestedPrice: 14,
  percentiles: [
    {
      percentile: 5,
      price: 10,
      estimatedTimeToSellMs: 10 * 24 * 60 * 60 * 1000,
      supplyStatus: "observed" as const,
    },
    {
      percentile: 65,
      price: 14,
      estimatedTimeToSellMs: 30 * 24 * 60 * 60 * 1000,
      supplyStatus: "observed" as const,
    },
  ],
});
const priceProfitPerDay = (
  sku: number,
  dailyReturnHurdle: number,
  overrides: Partial<Parameters<typeof calculator.calculatePrices>[1]> & {
    staticOverheadPerUnit?: number;
  } = {},
) => {
  const { staticOverheadPerUnit = 0.3, ...config } = overrides;
  return calculator.calculatePrices(
    [
      {
        sku,
        quantity: 1,
        currentPrice: 20,
        productLineId: 1,
        setId: 2,
        productId: 3,
      },
    ],
    {
      percentile: 65,
      policy: {
        method: "profit-per-day",
        dailyReturnHurdle,
        relativeOverhead: 0.15,
        staticOverheadPerUnit,
      },
      suggestedPriceResolver: twoPointResolver,
      ...config,
    },
  );
};

const profitPerDayResult = await priceProfitPerDay(459, 0.05);
assert.equal(profitPerDayResult.pricedItems[0]?.price, 10);
assert.equal(
  profitPerDayResult.pricedItems[0]?.pricingDecision?.method,
  "profit-per-day",
);
assert.equal(
  profitPerDayResult.pricedItems[0]?.pricingDecision?.dailyReturnHurdle,
  0.05,
);
assert.equal(
  profitPerDayResult.pricedItems[0]?.shadowPricingDecision?.method,
  "percentile",
);
assert.equal(profitPerDayResult.shadowPortfolioPlan, undefined);

console.log("PASS profit per day prices each SKU by discounted net proceeds");

const lossLimitingResult = await priceProfitPerDay(460, 0.005, {
  staticOverheadPerUnit: 20,
});
assert.equal(lossLimitingResult.pricedItems[0]?.price, 14);
assert.equal(
  lossLimitingResult.pricedItems[0]?.pricingDecision?.unprofitable,
  true,
);
assert.equal(
  lossLimitingResult.pricedItems[0]?.warnings?.[0],
  "No modeled price clears per-unit overhead. Listed at $14.00 to limit the loss.",
);

console.log("PASS profit per day lists at the least loss and says so");

const productLineHurdleResult = await priceProfitPerDay(461, 0.001, {
  productLinePricingConfig: {
    defaultPercentile: 65,
    productLineSettings: {
      1: { percentile: 65, skip: false, dailyReturnHurdle: 0.05 },
    },
  },
});
assert.equal(productLineHurdleResult.pricedItems[0]?.price, 10);
assert.equal(
  productLineHurdleResult.pricedItems[0]?.pricingDecision?.dailyReturnHurdle,
  0.05,
);

console.log("PASS a product line hurdle overrides the default hurdle");

const unavailableSupplyResult = await calculator.calculatePrices(
  [
    {
      sku: 789,
      quantity: 1,
      currentPrice: 20,
      productLineId: 1,
      setId: 2,
      productId: 3,
    },
  ],
  {
    percentile: 65,
    suggestedPriceResolver: async () => ({
      suggestedPrice: 14,
      percentiles: [
        {
          percentile: 5,
          price: 10,
          historicalSalesVelocityMs: 10 * 24 * 60 * 60 * 1000,
          supplyStatus: "unavailable",
        },
        {
          percentile: 95,
          price: 30,
          historicalSalesVelocityMs: 100 * 24 * 60 * 60 * 1000,
          supplyStatus: "unavailable",
        },
      ],
    }),
  },
);
assert.equal(unavailableSupplyResult.shadowPortfolioPlan?.modeledSkuCount, 0);
assert.equal(
  unavailableSupplyResult.shadowPortfolioPlan?.matchStatus,
  "infeasible",
);
assert.equal(
  unavailableSupplyResult.pricedItems[0]?.shadowPricingDecision?.basis,
  "current-price",
);
