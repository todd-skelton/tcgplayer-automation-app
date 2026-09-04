import assert from "node:assert/strict";
import {
  formatSignedPercent,
  formatSignedUsd,
  getMarketDeltaTone,
} from "~/core/utils/marketDelta";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";
import {
  compareLineToMarket,
  compareOrderToMarket,
  compareOrdersToMarket,
  compareShipmentToMarket,
  describeMarketCoverage,
  describeMarketDelta,
  getMarketDeltaAmount,
  getMarketDeltaPercent,
} from "./orderMarketComparison";

type TestCase = {
  name: string;
  run: () => void;
};

function createOrder(
  orderNumber: string,
  products: TcgPlayerShippingOrder["products"],
  valueOfProducts?: number,
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
      valueOfProducts ??
      products?.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) ??
      0,
    "Shipping Fee Paid": 0,
    "Tracking #": "",
    Carrier: "",
    products,
  };
}

function assertClose(actual: number | null, expected: number, message?: string) {
  assert.notEqual(actual, null, message);
  assert.ok(
    Math.abs((actual as number) - expected) < 0.000001,
    message ?? `expected ${actual} to be close to ${expected}`,
  );
}

const testCases: TestCase[] = [
  {
    name: "compareLineToMarket weights sold and market amounts by quantity",
    run: () => {
      const comparison = compareLineToMarket({
        name: "Pikachu",
        quantity: 3,
        unitPrice: 5,
        marketPrice: 4,
      });

      assert.equal(comparison.soldAmount, 15);
      assert.equal(comparison.marketAmount, 12);
      assert.equal(comparison.deltaAmount, 3);
      assertClose(comparison.deltaPercent, 25);
    },
  },
  {
    name: "compareLineToMarket reports no comparison when the market price is missing or zero",
    run: () => {
      const missing = compareLineToMarket({ name: "A", quantity: 1, unitPrice: 5 });
      const zero = compareLineToMarket({
        name: "B",
        quantity: 1,
        unitPrice: 5,
        marketPrice: 0,
      });

      assert.equal(missing.marketAmount, null);
      assert.equal(missing.deltaPercent, null);
      assert.equal(zero.marketAmount, null);
      assert.equal(zero.soldAmount, 5);
    },
  },
  {
    name: "compareOrderToMarket only compares lines that have a market price",
    run: () => {
      const comparison = compareOrderToMarket(
        createOrder("1001", [
          { name: "Priced", quantity: 2, unitPrice: 6, marketPrice: 5 },
          { name: "Unpriced", quantity: 1, unitPrice: 100 },
        ]),
      );

      assert.equal(comparison.soldTotal, 112);
      assert.equal(comparison.comparableSoldTotal, 12);
      assert.equal(comparison.comparableMarketTotal, 10);
      assert.equal(comparison.lineCount, 2);
      assert.equal(comparison.comparableLineCount, 1);
      assert.equal(getMarketDeltaAmount(comparison), 2);
      assertClose(getMarketDeltaPercent(comparison), 20);
      assert.equal(describeMarketCoverage(comparison), "1 of 2 lines priced");
    },
  },
  {
    name: "compareOrderToMarket falls back to the order value when lines are unavailable",
    run: () => {
      const comparison = compareOrderToMarket(createOrder("1001", undefined, 42.5));

      assert.equal(comparison.soldTotal, 42.5);
      assert.equal(comparison.lineCount, 0);
      assert.equal(getMarketDeltaPercent(comparison), null);
      assert.equal(describeMarketDelta(comparison), "No market price");
      assert.equal(describeMarketCoverage(comparison), "No line items");
    },
  },
  {
    name: "compareOrdersToMarket sums orders so combined shipments keep per-order math",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "A", quantity: 1, unitPrice: 10, marketPrice: 8 },
        ]),
        createOrder("1002", [
          { name: "B", quantity: 2, unitPrice: 3, marketPrice: 4 },
        ]),
      ];

      const comparison = compareOrdersToMarket(orders);

      assert.equal(comparison.soldTotal, 16);
      assert.equal(comparison.comparableMarketTotal, 16);
      assert.equal(getMarketDeltaAmount(comparison), 0);
      assert.equal(describeMarketDelta(comparison), "At market");
      assert.equal(describeMarketCoverage(comparison), null);
    },
  },
  {
    name: "compareShipmentToMarket resolves merged order numbers through the shipment map",
    run: () => {
      const orders = [
        createOrder("1001", [
          { name: "A", quantity: 1, unitPrice: 12, marketPrice: 10 },
        ]),
        createOrder("1002", [
          { name: "B", quantity: 1, unitPrice: 9, marketPrice: 10 },
        ]),
        createOrder("1003", [
          { name: "C", quantity: 1, unitPrice: 50, marketPrice: 10 },
        ]),
      ];

      const comparison = compareShipmentToMarket(
        orders,
        { "1001": ["1001", "1002"], "1003": ["1003"] },
        "1001",
      );

      assert.equal(comparison.soldTotal, 21);
      assert.equal(comparison.comparableMarketTotal, 20);
      assertClose(getMarketDeltaPercent(comparison), 5);
      assert.equal(describeMarketDelta(comparison), "5.0% above market");
    },
  },
  {
    name: "compareShipmentToMarket treats an unmapped reference as its own order",
    run: () => {
      const comparison = compareShipmentToMarket(
        [createOrder("1001", [{ name: "A", quantity: 1, unitPrice: 8, marketPrice: 10 }])],
        {},
        "1001",
      );

      assertClose(getMarketDeltaPercent(comparison), -20);
      assert.equal(describeMarketDelta(comparison), "20.0% below market");
    },
  },
  {
    name: "market delta formatting follows the sign convention used elsewhere in the app",
    run: () => {
      assert.equal(formatSignedPercent(8.44), "+8.4%");
      assert.equal(formatSignedPercent(-3.06), "-3.1%");
      assert.equal(formatSignedPercent(0.04), "0.0%");
      assert.equal(formatSignedUsd(3.2), "+$3.20");
      assert.equal(formatSignedUsd(-1.1), "-$1.10");
      assert.equal(formatSignedUsd(0), "$0.00");
      assert.equal(getMarketDeltaTone(null), "unavailable");
      assert.equal(getMarketDeltaTone(0.04), "at");
      assert.equal(getMarketDeltaTone(0.06), "above");
      assert.equal(getMarketDeltaTone(-2), "below");
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
  console.log(`Passed ${testCases.length} order market comparison tests.`);
}
