import assert from "node:assert/strict";
import type { Sale } from "~/integrations/tcgplayer/client/get-latest-sales.server";
import { getEffectiveSalePrice } from "./getSuggestedPriceFromLatestSales";

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

console.log(
  "PASS latest-sales pricing preserves unit prices and allocates only shipping",
);
