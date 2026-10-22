import assert from "node:assert/strict";
import { searchProducts } from "./productSearch";

type TestCase = {
  name: string;
  run: () => void;
};

const charizardPromo = {
  cardNumber: "001/099",
  displayName: "Charizard - 1/99 (Cracked Ice Holo) - Promo",
};
const charizard = {
  cardNumber: "1/99",
  displayName: "Charizard - Holo Rare",
};
const pikachu = {
  cardNumber: "025/198",
  displayName: "Pikachu - 025/198 - Rare Holo",
};
const boosterBox = {
  cardNumber: null,
  displayName: "Scarlet & Violet Booster Box",
};
const products = [charizardPromo, charizard, pikachu, boosterBox];

const testCases: TestCase[] = [
  {
    name: "an empty search keeps every product",
    run: () => {
      assert.deepEqual(searchProducts(products, "  "), products);
    },
  },
  {
    name: "a card number search finds cards whatever their zero padding",
    run: () => {
      assert.deepEqual(searchProducts(products, "1/99"), [
        charizardPromo,
        charizard,
      ]);
      assert.deepEqual(searchProducts(products, "001/099"), [
        charizardPromo,
        charizard,
      ]);
      assert.deepEqual(searchProducts(products, "25"), [pikachu]);
    },
  },
  {
    name: "a search that matches no card number finds names containing it",
    run: () => {
      assert.deepEqual(searchProducts(products, "charizard"), [
        charizardPromo,
        charizard,
      ]);
      assert.deepEqual(searchProducts(products, "Cracked Ice"), [
        charizardPromo,
      ]);
      assert.deepEqual(searchProducts(products, "booster"), [boosterBox]);
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
  console.log(`Passed ${testCases.length} product search tests.`);
}
