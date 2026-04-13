import assert from "node:assert/strict";
import { createShippingTcgplayerOrdersAction } from "./api.shipping-export-tcgplayer-orders.server";
import { DEFAULT_SHIPPING_EXPORT_CONFIG } from "../types/shippingExport";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

async function parseActionResult(result: {
  data: unknown;
  init?: ResponseInit | null;
}) {
  return {
    status: result.init?.status ?? 200,
    body: result.data,
  };
}

const testCases: TestCase[] = [
  {
    name: "shipping tcgplayer orders route rejects non-post methods",
    run: async () => {
      const action = createShippingTcgplayerOrdersAction();

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/tcgplayer-orders", {
          method: "GET",
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 405);
      assert.deepEqual(parsed.body, { error: "Method not allowed" });
    },
  },
  {
    name: "shipping tcgplayer orders route requires provided or saved seller key",
    run: async () => {
      const action = createShippingTcgplayerOrdersAction({
        getShippingExportConfig: async () => ({
          ...DEFAULT_SHIPPING_EXPORT_CONFIG,
          defaultSellerKey: "",
        }),
        loadSellerShippingOrders: async () => {
          throw new Error("should not be called");
        },
        loadSingleSellerShippingOrder: async () => {
          throw new Error("should not be called");
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/tcgplayer-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 400);
      assert.deepEqual(parsed.body, {
        error:
          "A seller key is required. Enter one on the shipping page or save a default in Shipping Configuration.",
      });
    },
  },
  {
    name: "shipping tcgplayer orders route falls back to saved seller key and returns warnings",
    run: async () => {
      let capturedSellerKey = "";
      const action = createShippingTcgplayerOrdersAction({
        getShippingExportConfig: async () => ({
          ...DEFAULT_SHIPPING_EXPORT_CONFIG,
          defaultSellerKey: "saved-seller",
        }),
        loadSellerShippingOrders: async (sellerKey) => {
          capturedSellerKey = sellerKey;
          return {
            sellerKey,
            totalOrders: 2,
            loadedOrderNumbers: ["1001"],
            orders: [
              {
                "Order #": "1001",
                FirstName: "Jane",
                LastName: "Doe",
                Address1: "123 Main",
                Address2: "",
                City: "Austin",
                State: "TX",
                PostalCode: "78701",
                Country: "US",
                "Order Date": "2026-04-12T00:00:00Z",
                "Product Weight": 0,
                "Shipping Method": "Standard",
                "Item Count": 1,
                "Value Of Products": 10,
                "Shipping Fee Paid": 0,
                "Tracking #": "",
                Carrier: "",
              },
            ],
            warnings: ["Failed to load seller order 1002: Error: 403"],
          };
        },
        loadSingleSellerShippingOrder: async () => {
          throw new Error("should not be called");
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/tcgplayer-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sellerKey: " " }),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.equal(capturedSellerKey, "saved-seller");
      assert.deepEqual(parsed.body, {
        sellerKey: "saved-seller",
        totalOrders: 2,
        loadedOrderNumbers: ["1001"],
        orders: [
          {
            "Order #": "1001",
            FirstName: "Jane",
            LastName: "Doe",
            Address1: "123 Main",
            Address2: "",
            City: "Austin",
            State: "TX",
            PostalCode: "78701",
            Country: "US",
            "Order Date": "2026-04-12T00:00:00Z",
            "Product Weight": 0,
            "Shipping Method": "Standard",
            "Item Count": 1,
            "Value Of Products": 10,
            "Shipping Fee Paid": 0,
            "Tracking #": "",
            Carrier: "",
          },
        ],
        warnings: ["Failed to load seller order 1002: Error: 403"],
      });
    },
  },
  {
    name: "shipping tcgplayer orders route prefers explicitly provided seller key",
    run: async () => {
      let capturedSellerKey = "";
      const action = createShippingTcgplayerOrdersAction({
        getShippingExportConfig: async () => ({
          ...DEFAULT_SHIPPING_EXPORT_CONFIG,
          defaultSellerKey: "saved-seller",
        }),
        loadSellerShippingOrders: async (sellerKey) => {
          capturedSellerKey = sellerKey;
          return {
            sellerKey,
            totalOrders: 0,
            loadedOrderNumbers: [],
            orders: [],
          };
        },
        loadSingleSellerShippingOrder: async () => {
          throw new Error("should not be called");
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/tcgplayer-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sellerKey: "manual-seller" }),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.equal(capturedSellerKey, "manual-seller");
      assert.deepEqual(parsed.body, {
        sellerKey: "manual-seller",
        totalOrders: 0,
        loadedOrderNumbers: [],
        orders: [],
      });
    },
  },
  {
    name: "shipping tcgplayer orders route uses the resolved seller key for single-order lookups",
    run: async () => {
      let capturedSellerKey = "";
      let capturedOrderNumber = "";
      const action = createShippingTcgplayerOrdersAction({
        getShippingExportConfig: async () => ({
          ...DEFAULT_SHIPPING_EXPORT_CONFIG,
          defaultSellerKey: "saved-seller",
        }),
        loadSellerShippingOrders: async () => {
          throw new Error("should not be called");
        },
        loadSingleSellerShippingOrder: async (sellerKey, orderNumber) => {
          capturedSellerKey = sellerKey;
          capturedOrderNumber = orderNumber;
          return {
            sellerKey,
            totalOrders: 1,
            loadedOrderNumbers: ["ORD-1001"],
            orders: [
              {
                "Order #": "ORD-1001",
                FirstName: "Jane",
                LastName: "Doe",
                Address1: "123 Main",
                Address2: "",
                City: "Austin",
                State: "TX",
                PostalCode: "78701",
                Country: "US",
                "Order Date": "2026-04-12T00:00:00Z",
                "Product Weight": 0,
                "Shipping Method": "Standard",
                "Item Count": 1,
                "Value Of Products": 10,
                "Shipping Fee Paid": 0,
                "Tracking #": "",
                Carrier: "",
              },
            ],
            warnings: ['Order ORD-1001 is currently "Shipped".'],
          };
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/tcgplayer-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber: " ORD-1001 " }),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.equal(capturedSellerKey, "saved-seller");
      assert.equal(capturedOrderNumber, "ORD-1001");
      assert.deepEqual(parsed.body, {
        sellerKey: "saved-seller",
        totalOrders: 1,
        loadedOrderNumbers: ["ORD-1001"],
        orders: [
          {
            "Order #": "ORD-1001",
            FirstName: "Jane",
            LastName: "Doe",
            Address1: "123 Main",
            Address2: "",
            City: "Austin",
            State: "TX",
            PostalCode: "78701",
            Country: "US",
            "Order Date": "2026-04-12T00:00:00Z",
            "Product Weight": 0,
            "Shipping Method": "Standard",
            "Item Count": 1,
            "Value Of Products": 10,
            "Shipping Fee Paid": 0,
            "Tracking #": "",
            Carrier: "",
          },
        ],
        warnings: ['Order ORD-1001 is currently "Shipped".'],
      });
    },
  },
  {
    name: "shipping tcgplayer orders route requires a seller key for single-order lookups too",
    run: async () => {
      const action = createShippingTcgplayerOrdersAction({
        getShippingExportConfig: async () => ({
          ...DEFAULT_SHIPPING_EXPORT_CONFIG,
          defaultSellerKey: "",
        }),
        loadSellerShippingOrders: async () => {
          throw new Error("should not be called");
        },
        loadSingleSellerShippingOrder: async () => {
          throw new Error("should not be called");
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/tcgplayer-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber: "ORD-2002" }),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 400);
      assert.deepEqual(parsed.body, {
        error:
          "A seller key is required. Enter one on the shipping page or save a default in Shipping Configuration.",
      });
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
  console.log(`Passed ${testCases.length} shipping tcgplayer orders route tests.`);
}
