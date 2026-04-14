import assert from "node:assert/strict";
import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";
import { allocatePullSheetItemsToShipments } from "./packPullSheet";

type TestCase = {
  name: string;
  run: () => void;
};

function createOrder(
  orderNumber: string,
  products: NonNullable<TcgPlayerShippingOrder["products"]>,
): TcgPlayerShippingOrder {
  return {
    "Order #": orderNumber,
    FirstName: "Jane",
    LastName: "Doe",
    Address1: "123 Main",
    Address2: "",
    City: "Austin",
    State: "TX",
    PostalCode: "78701",
    Country: "US",
    "Order Date": "2026-04-13",
    "Product Weight": 0,
    "Shipping Method": "Standard",
    "Item Count": products.reduce((sum, product) => sum + product.quantity, 0),
    "Value Of Products": 10,
    "Shipping Fee Paid": 0,
    "Tracking #": "",
    Carrier: "",
    products,
  };
}

function createPullSheetItem(
  skuId: number,
  productName: string,
  quantity: number,
): PullSheetItem {
  return {
    skuId,
    productLine: "Pokemon",
    productName,
    condition: "Near Mint",
    number: "1",
    set: "Base",
    rarity: "Rare",
    quantity,
    orderQuantity: "1",
    productId: skuId + 1000,
    productLineId: 1,
    variant: skuId % 2 === 0 ? "Reverse Holo" : "Holo",
    dbCondition: "Near Mint",
    found: true,
  };
}

const testCases: TestCase[] = [
  {
    name: "allocatePullSheetItemsToShipments matches exact sku quantities for a single shipment",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "Card A", quantity: 2, unitPrice: 1, skuId: 11 },
        ]),
      ];
      const matches = allocatePullSheetItemsToShipments(
        orders,
        {},
        [createPullSheetItem(11, "Card A", 2)],
      );

      assert.equal(matches["1001"]?.canRenderGrid, true);
      assert.equal(matches["1001"]?.matchedQuantity, 2);
      assert.equal(matches["1001"]?.items[0]?.productId, 1011);
    },
  },
  {
    name: "allocatePullSheetItemsToShipments supports combined shipments",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "Card A", quantity: 1, unitPrice: 1, skuId: 11 },
        ]),
        createOrder("1002", [
          { name: "Card B", quantity: 2, unitPrice: 1, skuId: 22 },
        ]),
      ];
      const matches = allocatePullSheetItemsToShipments(
        orders,
        { "1001": ["1001", "1002"] },
        [createPullSheetItem(11, "Card A", 1), createPullSheetItem(22, "Card B", 2)],
      );

      assert.equal(matches["1001"]?.canRenderGrid, true);
      assert.equal(matches["1001"]?.expectedQuantity, 3);
      assert.equal(matches["1001"]?.items.length, 2);
    },
  },
  {
    name: "allocatePullSheetItemsToShipments splits duplicate sku quantities across shipments",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "Card A", quantity: 1, unitPrice: 1, skuId: 11 },
        ]),
        createOrder("1002", [
          { name: "Card A", quantity: 2, unitPrice: 1, skuId: 11 },
        ]),
      ];
      const matches = allocatePullSheetItemsToShipments(
        orders,
        {},
        [createPullSheetItem(11, "Card A", 3)],
      );

      assert.equal(matches["1001"]?.matchedQuantity, 1);
      assert.equal(matches["1002"]?.matchedQuantity, 2);
      assert.equal(matches["1002"]?.canRenderGrid, true);
    },
  },
  {
    name: "allocatePullSheetItemsToShipments falls back when matching is incomplete",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "Card A", quantity: 2, unitPrice: 1, skuId: 11 },
        ]),
      ];
      const matches = allocatePullSheetItemsToShipments(
        orders,
        {},
        [createPullSheetItem(11, "Card A", 1)],
      );

      assert.equal(matches["1001"]?.canRenderGrid, false);
      assert.match(matches["1001"]?.fallbackReason ?? "", /incomplete/i);
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
  console.log(`Passed ${testCases.length} pack pull sheet allocation tests.`);
}
