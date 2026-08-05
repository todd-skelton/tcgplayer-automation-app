import assert from "node:assert/strict";
import {
  buildSellerInventoryUpdateForm,
  updateSellerInventory,
} from "./update-seller-inventory.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const request = {
  productId: 248731,
  sku: 5199433,
  absoluteQuantity: 29,
  price: 24.57,
};

const testCases: TestCase[] = [
  {
    name: "buildSellerInventoryUpdateForm emits the verified minimal payload",
    run: () => {
      const form = buildSellerInventoryUpdateForm(request);

      assert.equal(
        form.toString(),
        [
          "productQuantityPrices%5B0%5D%5BProductId%5D=248731",
          "productQuantityPrices%5B0%5D%5BConditionQuantityPrices%5D%5B0%5D%5BProductConditionId%5D=5199433",
          "productQuantityPrices%5B0%5D%5BConditionQuantityPrices%5D%5B0%5D%5BQuantity%5D=29",
          "productQuantityPrices%5B0%5D%5BConditionQuantityPrices%5D%5B0%5D%5BPrice%5D=24.57",
        ].join("&"),
      );
      assert.equal(form.size, 4);
      assert.equal(form.has("productQuantityPrices[0][AddToQuantity]"), false);
      assert.equal(
        form.has(
          "productQuantityPrices[0][ConditionQuantityPrices][0][ExistingQuantity]",
        ),
        false,
      );
    },
  },
  {
    name: "buildSellerInventoryUpdateForm always requires an absolute quantity",
    run: () => {
      assert.throws(
        () =>
          buildSellerInventoryUpdateForm({
            ...request,
            absoluteQuantity: Number.NaN,
          }),
        /absoluteQuantity must be a non-negative integer/,
      );
      assert.throws(
        () =>
          buildSellerInventoryUpdateForm({
            ...request,
            absoluteQuantity: -1,
          }),
        /absoluteQuantity must be a non-negative integer/,
      );
    },
  },
  {
    name: "updateSellerInventory accepts a confirmed update",
    run: async () => {
      let postedForm: URLSearchParams | undefined;

      await updateSellerInventory(request, async (form) => {
        postedForm = form;
        return { success: true };
      });

      assert.equal(
        postedForm?.get(
          "productQuantityPrices[0][ConditionQuantityPrices][0][Quantity]",
        ),
        "29",
      );
    },
  },
  {
    name: "updateSellerInventory rejects an unconfirmed update",
    run: async () => {
      await assert.rejects(
        updateSellerInventory(request, async () => ({ success: false })),
        /did not confirm the inventory update for SKU 5199433/,
      );
    },
  },
];

let failures = 0;

for (const testCase of testCases) {
  try {
    await testCase.run();
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
  console.log(`Passed ${testCases.length} seller inventory client tests.`);
}
