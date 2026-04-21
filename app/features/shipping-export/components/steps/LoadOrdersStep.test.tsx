import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDefaultShippingExportConfig,
  type TcgPlayerShippingOrder,
} from "../../types/shippingExport";
import { LoadOrdersStep } from "./LoadOrdersStep";

type TestCase = {
  name: string;
  run: () => void;
};

function createOrder(orderNumber = "1001"): TcgPlayerShippingOrder {
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
    "Order Date": "2026-04-13T09:00:00Z",
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

function renderLoadOrdersStep(
  overrides: Partial<React.ComponentProps<typeof LoadOrdersStep>> = {},
) {
  return renderToStaticMarkup(
    <LoadOrdersStep
      config={createDefaultShippingExportConfig()}
      sellerKeyInput=""
      singleOrderNumberInput=""
      sourceOrders={[createOrder()]}
      loadedSourceLabel="Live seller orders: demo"
      isLoadingLiveOrders={false}
      isLoadingSingleOrder={false}
      isLoadingExistingPostage={false}
      loadWarnings={[]}
      onSellerKeyChange={() => undefined}
      onSingleOrderNumberChange={() => undefined}
      onLoadLiveOrders={() => undefined}
      onLoadSingleOrder={() => undefined}
      onContinue={() => undefined}
      {...overrides}
    />,
  );
}

const testCases: TestCase[] = [
  {
    name: "LoadOrdersStep shows live and single-order loading controls",
    run: () => {
      const html = renderLoadOrdersStep();

      assert.match(html, /Live TCGPlayer Seller Orders/);
      assert.match(html, /Load Live TCGPlayer Orders/);
      assert.match(html, /Single Order Lookup/);
      assert.match(html, /Lookup Single Order/);
      assert.match(html, /Continue to Pull Sheet/);
    },
  },
  {
    name: "LoadOrdersStep no longer renders the legacy CSV upload section",
    run: () => {
      const html = renderLoadOrdersStep();

      assert.doesNotMatch(html, /Legacy: CSV Upload/);
      assert.doesNotMatch(html, /Upload TCGPlayer Shipping Export CSV/);
      assert.doesNotMatch(html, /type="file"/);
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
  console.log(`Passed ${testCases.length} LoadOrdersStep render tests.`);
}
