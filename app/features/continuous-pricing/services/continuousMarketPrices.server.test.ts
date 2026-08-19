import assert from "node:assert/strict";
import type { PricePoint } from "~/integrations/tcgplayer/client/get-price-points.server";
import { fetchContinuousMarketPrices } from "./continuousMarketPrices.server";

const requests: number[][] = [];
const skus = Array.from({ length: 501 }, (_, index) => index + 1);
const prices = await fetchContinuousMarketPrices(skus, async ({ skuIds }) => {
  requests.push(skuIds);
  return skuIds.map(
    (skuId): PricePoint => ({
      skuId,
      marketPrice: skuId === 501 ? 0 : skuId / 100,
      lowestPrice: 0,
      highestPrice: 0,
      priceCount: 1,
      calculatedAt: "2026-08-19T00:00:00.000Z",
    }),
  );
});

assert.deepEqual(
  requests.map((request) => request.length),
  [250, 250, 1],
);
assert.equal(prices.get(1), 0.01);
assert.equal(prices.get(500), 5);
assert.equal(prices.has(501), false);

console.log("PASS continuous market prices are fetched in bounded batches");
