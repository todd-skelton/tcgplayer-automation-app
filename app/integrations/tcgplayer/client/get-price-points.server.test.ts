import assert from "node:assert/strict";
import {
  fetchInventoryIntakeMarketObservation,
  fetchMarketPriceObservationsBySku,
  type PricePoint,
} from "./get-price-points.server";

const calculatedAt = "2026-09-07T14:05:00.000Z";
const observations = await fetchMarketPriceObservationsBySku(
  [41, 42],
  async ({ skuIds }) =>
    skuIds.map(
      (skuId): PricePoint => ({
        skuId,
        marketPrice: skuId === 41 ? 4.25 : 0,
        lowestPrice: 0,
        highestPrice: 0,
        priceCount: 1,
        calculatedAt,
      }),
    ),
);
assert.deepEqual(observations.get(41), { marketPrice: 4.25, calculatedAt });
assert.deepEqual(observations.get(42), { marketPrice: null, calculatedAt });

let aborted = false;
await assert.rejects(
  fetchInventoryIntakeMarketObservation(
    41,
    async (_request, options) =>
      new Promise<PricePoint[]>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
    10,
  ),
  /timed out/,
);
assert.equal(aborted, true);

console.log("PASS intake market observations preserve source time and honor their deadline");
