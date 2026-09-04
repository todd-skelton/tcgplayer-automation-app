import assert from "node:assert/strict";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";
import { attachMarketPricesToOrders } from "./orderMarketPrices.server";

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

function createOrder(
  orderNumber: string,
  products?: TcgPlayerShippingOrder["products"],
): TcgPlayerShippingOrder {
  return {
    "Order #": orderNumber,
    FirstName: "Ash",
    LastName: "Ketchum",
    Address1: "1 Pokemon Way",
    Address2: "",
    City: "Pallet",
    State: "CA",
    PostalCode: "90001",
    Country: "US",
    "Order Date": "2026-04-13",
    "Product Weight": 0,
    "Shipping Method": "Standard",
    "Item Count": 1,
    "Value Of Products": 4.99,
    "Shipping Fee Paid": 0,
    "Tracking #": "",
    Carrier: "",
    products,
  };
}

const testCases: TestCase[] = [
  {
    name: "attachMarketPricesToOrders looks up each SKU once and attaches the market price",
    run: async () => {
      const requestedSkus: number[][] = [];
      const result = await attachMarketPricesToOrders(
        [
          createOrder("1001", [
            { name: "A", quantity: 1, unitPrice: 5, skuId: 25 },
            { name: "B", quantity: 2, unitPrice: 3, skuId: 41 },
          ]),
          createOrder("1002", [
            { name: "A again", quantity: 1, unitPrice: 5, skuId: 25 },
            { name: "No SKU", quantity: 1, unitPrice: 1 },
          ]),
        ],
        async (skus) => {
          requestedSkus.push(skus);
          return new Map([[25, 4.5]]);
        },
      );

      assert.deepEqual(requestedSkus, [[25, 41, 25]]);
      assert.equal(result.warning, undefined);
      assert.equal(result.orders[0].products?.[0].marketPrice, 4.5);
      assert.equal(result.orders[0].products?.[1].marketPrice, undefined);
      assert.equal(result.orders[1].products?.[0].marketPrice, 4.5);
      assert.equal(result.orders[1].products?.[1].marketPrice, undefined);
    },
  },
  {
    name: "attachMarketPricesToOrders skips the lookup when no line has a SKU",
    run: async () => {
      let called = false;
      const orders = [createOrder("1001"), createOrder("1002", [])];
      const result = await attachMarketPricesToOrders(orders, async () => {
        called = true;
        return new Map();
      });

      assert.equal(called, false);
      assert.deepEqual(result.orders, orders);
    },
  },
  {
    name: "attachMarketPricesToOrders keeps the orders and warns when the lookup fails",
    run: async () => {
      const orders = [
        createOrder("1001", [{ name: "A", quantity: 1, unitPrice: 5, skuId: 25 }]),
      ];
      const result = await attachMarketPricesToOrders(orders, async () => {
        throw new Error("gateway down");
      });

      assert.deepEqual(result.orders, orders);
      assert.match(result.warning ?? "", /Market prices could not be loaded/);
      assert.match(result.warning ?? "", /gateway down/);
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
  console.log(`Passed ${testCases.length} order market price tests.`);
}
