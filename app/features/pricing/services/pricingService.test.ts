import assert from "node:assert/strict";
import { PRICING_CONSTANTS } from "~/core/constants/pricing";
import { calculateMarketplacePrice } from "./pricingService";

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
