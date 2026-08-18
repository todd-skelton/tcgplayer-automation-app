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

console.log(
  "PASS insufficient-sales fallbacks are warning-only priced results",
);
