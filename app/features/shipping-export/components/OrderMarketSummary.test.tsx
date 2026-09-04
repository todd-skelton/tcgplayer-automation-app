import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";
import { OrderMarketSummary } from "./OrderMarketSummary";

type TestCase = {
  name: string;
  run: () => void;
};

function createOrder(
  orderNumber: string,
  products: TcgPlayerShippingOrder["products"],
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
    "Item Count": products?.reduce((sum, line) => sum + line.quantity, 0) ?? 0,
    "Value Of Products":
      products?.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) ?? 0,
    "Shipping Fee Paid": 0,
    "Tracking #": "",
    Carrier: "",
    products,
  };
}

const testCases: TestCase[] = [
  {
    name: "OrderMarketSummary renders nothing before orders are loaded",
    run: () => {
      const html = renderToStaticMarkup(
        <OrderMarketSummary sourceOrders={[]} shipmentCount={0} />,
      );

      assert.equal(html, "");
    },
  },
  {
    name: "OrderMarketSummary shows sold, market, and the signed delta for the whole load",
    run: () => {
      const html = renderToStaticMarkup(
        <OrderMarketSummary
          sourceOrders={[
            createOrder("1001", [
              { name: "A", quantity: 2, unitPrice: 6, marketPrice: 5, skuId: 1 },
            ]),
            createOrder("1002", [
              { name: "B", quantity: 1, unitPrice: 10, marketPrice: 10, skuId: 2 },
            ]),
          ]}
          shipmentCount={2}
        />,
      );

      assert.match(html, /2 orders/);
      assert.match(html, /2 shipments · 2 lines/);
      assert.match(html, /\$22\.00/);
      assert.match(html, /\$20\.00/);
      assert.match(html, /\+10\.0% · \+\$2\.00/);
      assert.match(html, /10\.0% above market/);
      assert.match(html, /Every line has a market price/);
    },
  },
  {
    name: "OrderMarketSummary reports partial coverage and an unavailable delta",
    run: () => {
      const partial = renderToStaticMarkup(
        <OrderMarketSummary
          sourceOrders={[
            createOrder("1001", [
              { name: "Priced", quantity: 1, unitPrice: 4, marketPrice: 5, skuId: 1 },
              { name: "Unpriced", quantity: 1, unitPrice: 4, skuId: 2 },
            ]),
          ]}
          shipmentCount={1}
        />,
      );

      assert.match(partial, /1 of 2 lines priced/);
      assert.match(partial, /-20\.0% · -\$1\.00/);
      assert.match(partial, /20\.0% below market/);

      const unavailable = renderToStaticMarkup(
        <OrderMarketSummary
          sourceOrders={[
            createOrder("1001", [{ name: "Unpriced", quantity: 1, unitPrice: 4, skuId: 2 }]),
          ]}
          shipmentCount={1}
        />,
      );

      assert.match(unavailable, /Not available/);
      assert.match(unavailable, /No market price/);
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
  console.log(`Passed ${testCases.length} OrderMarketSummary render tests.`);
}
