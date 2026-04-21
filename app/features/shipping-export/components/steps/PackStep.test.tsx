import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PackPullSheetShipmentMatch } from "../../services/packPullSheet";
import type { TcgPlayerShippingOrder } from "../../types/shippingExport";
import { PackStep } from "./PackStep";

type TestCase = {
  name: string;
  run: () => void;
};

function createOrder(
  orderNumber = "1001",
  products: NonNullable<TcgPlayerShippingOrder["products"]> = [
    { name: "Pikachu", quantity: 1, unitPrice: 4.99, skuId: 25 },
  ],
): TcgPlayerShippingOrder {
  const valueOfProducts = products.reduce(
    (sum, product) => sum + product.quantity * product.unitPrice,
    0,
  );

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
    "Item Count": products.reduce((sum, product) => sum + product.quantity, 0),
    "Value Of Products": valueOfProducts,
    "Shipping Fee Paid": 0,
    "Tracking #": "",
    Carrier: "",
    products,
  };
}

function createPullSheetRow(
  productName: string,
  quantity: number,
  skuId: number,
) {
  return {
    skuId,
    productLine: "Pokemon",
    productName,
    condition: "Near Mint",
    number: String(skuId),
    set: "Base",
    rarity: "Common",
    quantity,
    orderQuantity: "1001:1",
    productId: skuId + 12000,
    productLineId: 1,
    variant: "Reverse Holo",
    dbCondition: "Near Mint" as const,
    found: true,
  };
}

function createMatch(
  canRenderGrid: boolean,
  items = [createPullSheetRow("Pikachu", 1, 25)],
): PackPullSheetShipmentMatch {
  const matchedQuantity = items.reduce((sum, item) => sum + item.quantity, 0);

  return {
    canRenderGrid,
    fallbackReason: canRenderGrid
      ? null
      : "Visual pull sheet matching was incomplete for this shipment.",
    expectedQuantity: matchedQuantity,
    matchedQuantity,
    items,
  };
}

function renderPackStep(
  overrides: Partial<React.ComponentProps<typeof PackStep>> = {},
) {
  return renderToStaticMarkup(
    <PackStep
      sourceOrders={[createOrder()]}
      shipmentReferences={["1001"]}
      shipmentToOrderMap={{}}
      outboundPurchaseResultsByReference={{}}
      packPullSheetStatus="ready"
      packPullSheetError={null}
      packPullSheetMatchesByReference={{ "1001": createMatch(true) }}
      packedOrderNumbers={new Set()}
      onOrderPacked={() => undefined}
      onBack={() => undefined}
      onContinue={() => undefined}
      {...overrides}
    />,
  );
}

const testCases: TestCase[] = [
  {
    name: "PackStep shows a loading message while the visual pull sheet is being prepared",
    run: () => {
      const html = renderPackStep({
        packPullSheetStatus: "loading",
        packPullSheetMatchesByReference: {},
      });

      assert.match(html, /Loading visual pull sheet for this shipment/);
    },
  },
  {
    name: "PackStep renders the pull sheet grid when a shipment has a visual match",
    run: () => {
      const html = renderPackStep();

      assert.match(html, /Shipment Details/);
      assert.match(html, /Order 1001/);
      assert.match(html, /12025_in_400x400\.jpg/);
      assert.match(html, /Pikachu/);
    },
  },
  {
    name: "PackStep breaks combined shipments into separate order sections",
    run: () => {
      const html = renderPackStep({
        sourceOrders: [
          createOrder("1001", [
            { name: "Abra", quantity: 1, unitPrice: 4.99, skuId: 63 },
          ]),
          createOrder("1002", [
            { name: "Zubat", quantity: 1, unitPrice: 4.99, skuId: 41 },
          ]),
        ],
        shipmentReferences: ["1001"],
        shipmentToOrderMap: { "1001": ["1001", "1002"] },
        packPullSheetMatchesByReference: {
          "1001": createMatch(true, [
            { ...createPullSheetRow("Abra", 1, 63), orderQuantity: "1001:1" },
            { ...createPullSheetRow("Zubat", 1, 41), orderQuantity: "1002:1" },
          ]),
        },
      });

      const order1001Index = html.indexOf("Order 1001");
      const order1002Index = html.indexOf("Order 1002");

      assert.match(html, /Combined shipment/);
      assert.notEqual(order1001Index, -1);
      assert.notEqual(order1002Index, -1);
      assert.ok(
        order1001Index < order1002Index,
        "expected combined shipment sections to follow order sequence",
      );
      assert.match(html, /Abra/);
      assert.match(html, /Zubat/);
    },
  },
  {
    name: "PackStep uses pull sheet row order for each order fallback table",
    run: () => {
      const html = renderPackStep({
        sourceOrders: [
          createOrder("1001", [
            { name: "Zubat", quantity: 1, unitPrice: 4.99, skuId: 41 },
            { name: "Abra", quantity: 1, unitPrice: 4.99, skuId: 63 },
          ]),
        ],
        packPullSheetMatchesByReference: {
          "1001": createMatch(false, [
            { ...createPullSheetRow("Abra", 1, 63), orderQuantity: "1001:1" },
            { ...createPullSheetRow("Zubat", 1, 41), orderQuantity: "1001:1" },
          ]),
        },
      });

      const order1001Index = html.indexOf("Order 1001");
      const abraIndex = html.indexOf("Abra");
      const zubatIndex = html.indexOf("Zubat");

      assert.match(html, /Showing the shipment item list instead/);
      assert.match(html, /<table/);
      assert.notEqual(order1001Index, -1);
      assert.notEqual(abraIndex, -1);
      assert.notEqual(zubatIndex, -1);
      assert.ok(
        order1001Index < abraIndex && abraIndex < zubatIndex,
        "expected fallback order section to preserve pull sheet row order",
      );
    },
  },
  {
    name: "PackStep follows the explicit shipment reference order in list and card views",
    run: () => {
      const html = renderPackStep({
        sourceOrders: [
          createOrder("1001", [
            { name: "Abra", quantity: 1, unitPrice: 4.99, skuId: 63 },
          ]),
          createOrder("1002", [
            { name: "Zubat", quantity: 1, unitPrice: 4.99, skuId: 41 },
          ]),
        ],
        shipmentReferences: ["1002", "1001"],
        shipmentToOrderMap: {
          "1001": ["1001"],
          "1002": ["1002"],
        },
        packPullSheetMatchesByReference: {
          "1001": createMatch(true, [
            { ...createPullSheetRow("Abra", 1, 63), orderQuantity: "1001:1" },
          ]),
          "1002": createMatch(true, [
            { ...createPullSheetRow("Zubat", 1, 41), orderQuantity: "1002:1" },
          ]),
        },
      });

      assert.match(html, /Shipment 1 of 2/);
      assert.match(html, /Order 1002/);
      assert.doesNotMatch(html, /Order 1001/);
    },
  },
  {
    name: "PackStep falls back to the aggregated table for an order with no ordered pull sheet rows",
    run: () => {
      const html = renderPackStep({
        sourceOrders: [
          createOrder("1001", [
            { name: "Pikachu", quantity: 1, unitPrice: 4.99, skuId: 25 },
          ]),
        ],
        packPullSheetMatchesByReference: {
          "1001": {
            ...createMatch(false, []),
            expectedQuantity: 1,
            matchedQuantity: 0,
          },
        },
      });

      assert.match(html, /Order 1001/);
      assert.match(html, /Pikachu/);
      assert.match(html, /<table/);
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
  console.log(`Passed ${testCases.length} PackStep render tests.`);
}
