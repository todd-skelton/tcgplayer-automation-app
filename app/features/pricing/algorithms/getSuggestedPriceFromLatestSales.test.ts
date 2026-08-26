import assert from "node:assert/strict";
import { PERCENTILES } from "~/core/constants/pricing";
import type { Sale } from "~/integrations/tcgplayer/client/get-latest-sales.server";
import {
  getEffectiveSalePrice,
  getSuggestedPriceFromSales,
} from "./getSuggestedPriceFromLatestSales";

function createSale(
  quantity: number,
  purchasePrice: number,
  shippingPrice = 0,
): Sale {
  return {
    condition: "Unopened",
    variant: "Normal",
    language: "English",
    quantity,
    title: "",
    listingType: "ListingWithoutPhotos",
    customListingId: "",
    purchasePrice,
    shippingPrice,
    orderDate: "2026-08-22T00:00:00.000Z",
  };
}

for (const quantity of [1, 2, 6, 10]) {
  assert.equal(
    getEffectiveSalePrice(createSale(quantity, 5.39)),
    5.39,
    `quantity ${quantity} preserves the per-unit purchase price`,
  );
}

assert.equal(
  getEffectiveSalePrice(createSale(2, 5.39, 1)),
  5.89,
  "order shipping is allocated across the purchased units",
);

assert.equal(
  getEffectiveSalePrice(createSale(0, 5.39, 1)),
  6.39,
  "invalid quantities fall back to one unit",
);

assert.equal(
  getEffectiveSalePrice(createSale(10, 4.99, 1)),
  4.99,
  "shipping below the existing five-dollar threshold remains excluded",
);

assert.deepEqual(
  PERCENTILES,
  Array.from({ length: 19 }, (_, index) => 5 + index * 5),
  "standard pricing curves cover 5th through 95th in five-point steps",
);

const curve = getSuggestedPriceFromSales(
  [
    { price: 1, quantity: 1, timestamp: Date.now() - 86_400_000 },
    { price: 2, quantity: 1, timestamp: Date.now() },
  ],
  { percentile: 73, halfLifeDays: 7 },
);
assert.deepEqual(
  curve.percentiles.map(({ percentile }) => percentile),
  [...PERCENTILES, 73].sort((left, right) => left - right),
  "pricing preserves a custom target alongside the standard exact curve",
);

console.log(
  "PASS latest-sales pricing preserves unit prices and allocates only shipping",
);
