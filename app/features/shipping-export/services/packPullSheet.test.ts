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
  orderQuantity = "1001:1",
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
    orderQuantity,
    productId: skuId + 1000,
    productLineId: 1,
    variant: skuId % 2 === 0 ? "Reverse Holo" : "Holo",
    dbCondition: "Near Mint",
    found: true,
  };
}

const testCases: TestCase[] = [
  {
    name: "allocatePullSheetItemsToShipments preserves pull sheet row order for a single shipment",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "Card B", quantity: 1, unitPrice: 1, skuId: 22 },
          { name: "Card A", quantity: 1, unitPrice: 1, skuId: 11 },
        ]),
      ];
      const matches = allocatePullSheetItemsToShipments(
        ["1001"],
        orders,
        {},
        [
          createPullSheetItem(11, "Card A", 1, "1001:1"),
          createPullSheetItem(22, "Card B", 1, "1001:1"),
        ],
      );

      assert.equal(matches["1001"]?.canRenderGrid, true);
      assert.equal(matches["1001"]?.matchedQuantity, 2);
      assert.deepEqual(
        matches["1001"]?.items.map((item) => item.productName),
        ["Card A", "Card B"],
      );
    },
  },
  {
    name: "allocatePullSheetItemsToShipments preserves global pull sheet order for combined shipments",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "Card A", quantity: 1, unitPrice: 1, skuId: 11 },
        ]),
        createOrder("1002", [
          { name: "Card B", quantity: 2, unitPrice: 1, skuId: 22 },
          { name: "Card A", quantity: 1, unitPrice: 1, skuId: 11 },
        ]),
      ];
      const matches = allocatePullSheetItemsToShipments(
        ["1001"],
        orders,
        { "1001": ["1001", "1002"] },
        [
          createPullSheetItem(22, "Card B", 1, "1002:1"),
          createPullSheetItem(11, "Card A", 2, "1001:1 | 1002:1"),
          createPullSheetItem(22, "Card B", 1, "1002:1"),
        ],
      );

      assert.equal(matches["1001"]?.canRenderGrid, true);
      assert.equal(matches["1001"]?.expectedQuantity, 4);
      assert.deepEqual(
        matches["1001"]?.items.map((item) => ({
          name: item.productName,
          quantity: item.quantity,
        })),
        [
          { name: "Card B", quantity: 1 },
          { name: "Card A", quantity: 2 },
          { name: "Card B", quantity: 1 },
        ],
      );
    },
  },
  {
    name: "allocatePullSheetItemsToShipments keeps duplicate sku rows in original order per shipment",
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
        ["1001", "1002"],
        orders,
        {},
        [
          createPullSheetItem(11, "Card A", 1, "1002:1"),
          createPullSheetItem(11, "Card A", 1, "1001:1"),
          createPullSheetItem(11, "Card A", 1, "1002:1"),
        ],
      );

      assert.equal(matches["1001"]?.matchedQuantity, 1);
      assert.equal(matches["1002"]?.matchedQuantity, 2);
      assert.deepEqual(
        matches["1001"]?.items.map((item) => item.quantity),
        [1],
      );
      assert.deepEqual(
        matches["1002"]?.items.map((item) => item.quantity),
        [1, 1],
      );
      assert.equal(matches["1002"]?.canRenderGrid, true);
    },
  },
  {
    name: "allocatePullSheetItemsToShipments falls back when order quantity data is malformed",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "Card A", quantity: 1, unitPrice: 1, skuId: 11 },
        ]),
      ];
      const matches = allocatePullSheetItemsToShipments(
        ["1001"],
        orders,
        {},
        [createPullSheetItem(11, "Card A", 1, "bad-data")],
      );

      assert.equal(matches["1001"]?.canRenderGrid, false);
      assert.equal(matches["1001"]?.matchedQuantity, 0);
      assert.match(
        matches["1001"]?.fallbackReason ?? "",
        /missing or malformed/i,
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
  console.log(`Passed ${testCases.length} pack pull sheet allocation tests.`);
}
