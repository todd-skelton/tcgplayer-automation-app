import assert from "node:assert/strict";
import { PRICING_CONSTANTS } from "~/core/constants/pricing";
import {
  calculateInsufficientSalesFallback,
  calculateMarketplacePrice,
} from "./pricingService";

type TestCase = {
  name: string;
  run: () => void;
};

const testCases: TestCase[] = [
  {
    name: "calculateMarketplacePrice keeps the default minimum price behavior",
    run: () => {
      const result = calculateMarketplacePrice(5, { marketPrice: 10 });
      const expectedMinimum =
        10 * PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER -
        PRICING_CONSTANTS.MIN_PRICE_CONSTANT;

      assert.equal(result.marketplacePrice, expectedMinimum);
      assert.equal(
        result.warningMessage,
        "Suggested price below minimum. Using minimum price.",
      );
    },
  },
  {
    name: "calculateMarketplacePrice honors the pricing job minimum configuration",
    run: () => {
      const result = calculateMarketplacePrice(
        5,
        { marketPrice: 10 },
        {
          minPriceMultiplier: 0.75,
          minPriceConstant: 0.25,
        },
      );

      assert.equal(result.marketplacePrice, 7.25);
      assert.equal(
        result.warningMessage,
        "Suggested price below minimum. Using minimum price.",
      );
    },
  },
  {
    name: "calculateMarketplacePrice lets the SKU's own evidence lower the floor",
    run: () => {
      const config = { minPriceMultiplier: 0.75, minPriceConstant: 0.25 };
      const ask = calculateMarketplacePrice(5, { marketPrice: 10 }, config, {
        secondCheapestAskPrice: 6,
      });
      assert.equal(ask.marketplacePrice, 6);
      assert.equal(
        ask.warningMessage,
        "Suggested price below minimum. Using minimum price.",
      );

      const sale = calculateMarketplacePrice(5, { marketPrice: 10 }, config, {
        ownConditionLowSalePrice: 4,
        secondCheapestAskPrice: 6,
      });
      assert.equal(sale.marketplacePrice, 5);
      assert.equal(sale.warningMessage, "");

      const noMarket = calculateMarketplacePrice(5, null, config, {
        secondCheapestAskPrice: 6,
      });
      assert.equal(
        noMarket.marketplacePrice,
        5,
        "evidence lowers the market floor but never creates one",
      );

      const penny = calculateMarketplacePrice(0.05, { marketPrice: 0.05 });
      assert.equal(penny.marketplacePrice, 0.05);
      assert.equal(
        penny.warningMessage,
        "",
        "a market price too small to bound anything is not a missing one",
      );
    },
  },
  {
    name: "insufficient sales use the higher market or listing price",
    run: () => {
      const listingWins = calculateInsufficientSalesFallback({
        marketPrice: 10,
        lowestListingPrice: 12.34,
        currentPrice: 20,
      });
      const marketWins = calculateInsufficientSalesFallback({
        marketPrice: 15.67,
        lowestListingPrice: 12,
        currentPrice: 20,
      });

      assert.equal(listingWins?.price, 12.34);
      assert.equal(listingWins?.basis, "market-and-listing-reference");
      assert.match(listingWins?.warningMessage ?? "", /highest available/);
      assert.equal(marketWins?.price, 15.67);
      assert.equal(marketWins?.basis, "market-and-listing-reference");
    },
  },
  {
    name: "insufficient sales use either available reference price",
    run: () => {
      assert.equal(
        calculateInsufficientSalesFallback({ lowestListingPrice: 8.25 })?.price,
        8.25,
      );
      assert.equal(
        calculateInsufficientSalesFallback({ lowestListingPrice: 8.25 })?.basis,
        "listing-reference",
      );
      assert.equal(
        calculateInsufficientSalesFallback({ marketPrice: 9.5 })?.price,
        9.5,
      );
    },
  },
  {
    name: "insufficient sales keep the current price without references",
    run: () => {
      const result = calculateInsufficientSalesFallback({ currentPrice: 4.99 });

      assert.equal(result?.price, 4.99);
      assert.match(result?.warningMessage ?? "", /Keeping the current price/);
      assert.equal(result?.basis, "current-price");
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`Passed ${testCases.length} pricing service tests.`);
}
