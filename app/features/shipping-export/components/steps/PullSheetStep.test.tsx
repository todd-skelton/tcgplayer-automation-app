import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import type {
  EasyPostShipment,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";
import { PullSheetStep } from "./PullSheetStep";

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

function createShipment(): EasyPostShipment {
  return {
    reference: "1001",
    carrier: "USPS",
    service: "First",
    to_address: {
      name: "Ash Ketchum",
      street1: "1 Pokemon Way",
      city: "Pallet",
      state: "CA",
      zip: "90001",
      country: "US",
    },
    from_address: {
      name: "Warehouse",
      street1: "123 Main",
      city: "Austin",
      state: "TX",
      zip: "78701",
      country: "US",
    },
    return_address: {
      name: "Warehouse",
      street1: "123 Main",
      city: "Austin",
      state: "TX",
      zip: "78701",
      country: "US",
    },
    parcel: {
      length: 1,
      width: 1,
      height: 1,
      weight: 1,
      predefined_package: "Letter",
    },
    options: {
      label_format: "PDF",
      label_size: "4x6",
      invoice_number: "1001",
      delivery_confirmation: "NO_SIGNATURE",
    },
  };
}

function createPullSheetItems(): PullSheetItem[] {
  return [
    {
      skuId: 25,
      productLine: "Pokemon",
      productName: "Pikachu",
      condition: "Near Mint",
      number: "25",
      set: "Base",
      rarity: "Common",
      quantity: 1,
      orderQuantity: "1001",
      productId: 12345,
      productLineId: 1,
      variant: "Reverse Holo",
      dbCondition: "Near Mint",
      found: true,
    },
  ];
}

function renderPullSheetStep(
  overrides: Partial<React.ComponentProps<typeof PullSheetStep>> = {},
) {
  return renderToStaticMarkup(
    <PullSheetStep
      sourceOrders={[createOrder()]}
      shipments={[createShipment()]}
      pullSheetItems={createPullSheetItems()}
      pullSheetOrderIds={["1001"]}
      isLoadingPullSheet={false}
      pullSheetError={null}
      onBack={() => undefined}
      onContinue={() => undefined}
      {...overrides}
    />,
  );
}

const testCases: TestCase[] = [
  {
    name: "PullSheetStep embeds the pull sheet and defaults to card view",
    run: () => {
      const html = renderPullSheetStep();

      assert.match(html, /Pull Sheet Workspace/);
      assert.match(html, /Card View/);
      assert.match(html, /Grid View/);
      assert.match(html, /12345_in_400x400\.jpg/);
      assert.doesNotMatch(html, /Open Pull Sheet/);
    },
  },
  {
    name: "PullSheetStep shows a loading message while the embedded pull sheet is loading",
    run: () => {
      const html = renderPullSheetStep({
        pullSheetItems: [],
        isLoadingPullSheet: true,
      });

      assert.match(html, /Loading the embedded pull sheet from the current order set/);
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
  console.log(`Passed ${testCases.length} PullSheetStep render tests.`);
}
