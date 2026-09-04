import assert from "node:assert/strict";
import { BUYER_CHOICE_CALIBRATION } from "../algorithms/buyerChoiceSellTime";
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
          listingsCount: 0,
          supplyStatus: "observed",
        },
        {
          percentile: 65,
          price: 14,
          historicalSalesVelocityMs: 30 * 24 * 60 * 60 * 1000,
          estimatedTimeToSellMs: 30 * 24 * 60 * 60 * 1000,
          salesCount: 6,
          listingsCount: 3,
          supplyStatus: "observed",
        },
        {
          percentile: 95,
          price: 30,
          historicalSalesVelocityMs: 100 * 24 * 60 * 60 * 1000,
          estimatedTimeToSellMs: 100 * 24 * 60 * 60 * 1000,
          salesCount: 2,
          listingsCount: 9,
          supplyStatus: "observed",
        },
      ],
    }),
  },
);

assert.equal(shadowResult.pricedItems[0]?.suggestedPrice, 14);
const forecast = shadowResult.pricedItems[0]?.buyerChoiceForecast;
assert.equal(forecast?.calibration, BUYER_CHOICE_CALIBRATION.name);
assert.ok(
  (forecast?.medianSellDays ?? 0) > 0,
  "a modeled price records the buyer-choice forecast at the listed price",
);
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

assert.equal(targetUnavailableResult.pricedItems[0]?.price, 14);
assert.equal(
  targetUnavailableResult.pricedItems[0]?.pricingDecision?.basis,
  "modeled",
);
assert.equal(
  targetUnavailableResult.pricedItems[0]?.pricingDecision?.method,
  "target-horizon",
);
assert.equal(
  targetUnavailableResult.pricedItems[0]?.pricingDecision?.targetHorizonDays,
  20,
);
assert.equal(
  targetUnavailableResult.pricedItems[0]?.pricingDecision?.forecastStatus,
  "unavailable",
);
assert.deepEqual(targetUnavailableResult.pricedItems[0]?.warnings, [
  "Target-horizon forecast unavailable. Priced at percentile 65 instead.",
  "No market price available. Using suggested price directly.",
]);

console.log(
  "PASS target horizon falls back to the percentile when forecasting is unavailable",
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
    pricePoints?: Parameters<typeof calculator.calculatePrices>[2];
  } = {},
) => {
  const { staticOverheadPerUnit = 0.3, pricePoints, ...config } = overrides;
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
    pricePoints,
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

const marketPoints = (sku: number, marketPrice: number) =>
  new Map([
    [
      sku,
      {
        skuId: sku,
        marketPrice,
        lowestPrice: marketPrice,
        highestPrice: marketPrice,
        priceCount: 1,
        calculatedAt: "2026-08-18T12:00:00.000Z",
      },
    ],
  ]);

const salesOnlyResolver = (price: number) => async () => ({
  suggestedPrice: price,
  percentiles: [
    { percentile: 5, price: price / 2, supplyStatus: "disabled" as const },
    { percentile: 65, price, supplyStatus: "disabled" as const },
  ],
});

// Sales-based percentiles without supply data beat the market price, and the
// forecast stays unavailable so the price is reviewed.
const supplyDisabled = await priceProfitPerDay(470, 0.005, {
  suggestedPriceResolver: salesOnlyResolver(14),
  pricePoints: marketPoints(470, 9.85),
});
const supplyDisabledDecision = supplyDisabled.pricedItems[0]?.pricingDecision;
assert.equal(supplyDisabled.pricedItems[0]?.price, 14);
assert.equal(supplyDisabledDecision?.method, "profit-per-day");
assert.equal(supplyDisabledDecision?.dailyReturnHurdle, 0.005);
assert.equal(supplyDisabledDecision?.basis, "modeled");
assert.equal(supplyDisabledDecision?.forecastStatus, "unavailable");
assert.equal(supplyDisabledDecision?.configuredPercentile, 65);
assert.equal(supplyDisabledDecision?.unprofitable, undefined);
assert.deepEqual(supplyDisabled.pricedItems[0]?.warnings, [
  "Profit-per-day forecast unavailable. Priced at percentile 65 instead.",
]);

// A percentile price that does not clear overhead is flagged like any other.
const losing = await priceProfitPerDay(473, 0.005, {
  suggestedPriceResolver: salesOnlyResolver(0.25),
  pricePoints: marketPoints(473, 0.3),
});
assert.equal(losing.pricedItems[0]?.price, 0.25);
assert.equal(losing.pricedItems[0]?.pricingDecision?.unprofitable, true);
assert.deepEqual(losing.pricedItems[0]?.warnings, [
  "Profit-per-day forecast unavailable. Priced at percentile 65 instead.",
  "No modeled price clears per-unit overhead. Listed at $0.25 to limit the loss.",
]);

// With no curve, the reference ladder is the percentile policy's own.
const marketOnly = await priceProfitPerDay(471, 0.005, {
  suggestedPriceResolver: async () => ({ suggestedPrice: null }),
  pricePoints: marketPoints(471, 9.85),
});
assert.equal(marketOnly.pricedItems[0]?.price, 9.85);
assert.equal(
  marketOnly.pricedItems[0]?.pricingDecision?.method,
  "profit-per-day",
);
assert.equal(
  marketOnly.pricedItems[0]?.pricingDecision?.basis,
  "market-reference",
);
assert.equal(
  marketOnly.pricedItems[0]?.pricingDecision?.forecastStatus,
  "unavailable",
);
assert.deepEqual(marketOnly.pricedItems[0]?.warnings, [
  "Profit-per-day forecast unavailable. Insufficient sales history. Using the highest available reference price (TCG market $9.85): $9.85.",
]);

const listingOnly = await priceProfitPerDay(472, 0.005, {
  suggestedPriceResolver: async () => ({
    suggestedPrice: null,
    lowestListingPrice: 12.34,
  }),
});
assert.equal(listingOnly.pricedItems[0]?.price, 12.34);
assert.equal(
  listingOnly.pricedItems[0]?.pricingDecision?.basis,
  "listing-reference",
);

const nothing = await priceProfitPerDay(474, 0.005, {
  suggestedPriceResolver: async () => ({ suggestedPrice: null }),
});
assert.equal(nothing.pricedItems[0]?.price, 20);
assert.equal(nothing.pricedItems[0]?.pricingDecision?.basis, "current-price");
assert.deepEqual(nothing.pricedItems[0]?.warnings, [
  "Profit-per-day forecast unavailable. Insufficient sales history and no market price or listing is available. Keeping the current price at $20.00.",
]);

console.log(
  "PASS an unavailable forecast prices as the percentile policy would and stays unavailable",
);

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
