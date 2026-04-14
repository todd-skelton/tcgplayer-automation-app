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

function createOrder(): TcgPlayerShippingOrder {
  return {
    "Order #": "1001",
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
    products: [{ name: "Pikachu", quantity: 1, unitPrice: 4.99, skuId: 25 }],
  };
}

function createMatch(canRenderGrid: boolean): PackPullSheetShipmentMatch {
  return {
    canRenderGrid,
    fallbackReason: canRenderGrid ? null : "Visual pull sheet matching was incomplete for Pikachu.",
    expectedQuantity: 1,
    matchedQuantity: canRenderGrid ? 1 : 0,
    items: canRenderGrid
      ? [
          {
            skuId: 25,
            productLine: "Pokemon",
            productName: "Pikachu",
            condition: "Near Mint",
            number: "25",
            set: "Base",
            rarity: "Common",
            quantity: 1,
            orderQuantity: "ORD-1",
            productId: 12345,
            productLineId: 1,
            variant: "Reverse Holo",
            dbCondition: "Near Mint",
            found: true,
          },
        ]
      : [],
  };
}

function renderPackStep(
  overrides: Partial<React.ComponentProps<typeof PackStep>> = {},
) {
  return renderToStaticMarkup(
    <PackStep
      sourceOrders={[createOrder()]}
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

      assert.match(html, /12345_in_400x400\.jpg/);
      assert.match(html, /Pikachu/);
    },
  },
  {
    name: "PackStep falls back to the simple shipment table when visual matching is unavailable",
    run: () => {
      const html = renderPackStep({
        packPullSheetMatchesByReference: { "1001": createMatch(false) },
      });

      assert.match(html, /Showing the shipment item list instead/);
      assert.match(html, /<table/);
      assert.match(html, /Pikachu/);
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
