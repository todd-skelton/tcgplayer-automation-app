import assert from "node:assert/strict";
import { createShippingPostagesAction } from "./api.shipping-export-postages.server";
import { DEFAULT_SHIPPING_EXPORT_CONFIG } from "../types/shippingExport";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

function createValidRequestBody() {
  return {
    labelSize: "4x6",
    shipments: [
      {
        shipment: {
          reference: "1001",
          to_address: {
            name: "Jane Doe",
            street1: "123 Main St",
            city: "Dallas",
            state: "TX",
            zip: "75001",
            country: "US",
          },
          from_address: {
            name: "Warehouse",
            street1: "456 Commerce Blvd",
            city: "Austin",
            state: "TX",
            zip: "78701",
            country: "US",
          },
          return_address: {
            name: "Warehouse",
            street1: "456 Commerce Blvd",
            city: "Austin",
            state: "TX",
            zip: "78701",
            country: "US",
          },
          parcel: {
            length: 9,
            width: 6,
            height: 1,
            weight: 4,
            predefined_package: "Flat",
          },
          carrier: "USPS",
          service: "GroundAdvantage",
          options: {
            label_format: "PDF",
            label_size: "4x6",
            invoice_number: "1001",
            delivery_confirmation: "NO_SIGNATURE",
          },
        },
        orderNumbers: ["1001"],
      },
    ],
  };
}

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
    name: "shipping postage route returns purchased results",
    run: async () => {
      let capturedMode: string | null = null;
      let capturedLabelSize: string | null = null;
      let capturedShipmentCount = 0;
      const action = createShippingPostagesAction({
        getShippingExportConfig: async () => ({
          ...DEFAULT_SHIPPING_EXPORT_CONFIG,
          easypostMode: "test",
        }),
        purchaseShippingPostages: async (mode, labelSize, shipments) => {
          capturedMode = mode;
          capturedLabelSize = labelSize;
          capturedShipmentCount = shipments.length;
          return {
            mode,
            batchLabel: {
              status: "ready",
              shipmentReferences: ["1001"],
              batchId: "batch_123",
              labelUrl: "https://example.com/batch.pdf",
            },
            results: [
              {
                reference: "1001",
                orderNumbers: ["1001"],
                status: "purchased",
                trackingCode: "9400",
              },
            ],
          };
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/postages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createValidRequestBody()),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.equal(capturedMode, "test");
      assert.equal(capturedLabelSize, "4x6");
      assert.equal(capturedShipmentCount, 1);
      assert.deepEqual(parsed.body, {
        mode: "test",
        batchLabel: {
          status: "ready",
          shipmentReferences: ["1001"],
          batchId: "batch_123",
          labelUrl: "https://example.com/batch.pdf",
        },
        results: [
          {
            reference: "1001",
            orderNumbers: ["1001"],
            status: "purchased",
            trackingCode: "9400",
          },
        ],
      });
    },
  },
  {
    name: "shipping postage route preserves partial-success results",
    run: async () => {
      const action = createShippingPostagesAction({
        getShippingExportConfig: async () => DEFAULT_SHIPPING_EXPORT_CONFIG,
        purchaseShippingPostages: async (mode) => ({
          mode,
          batchLabel: {
            status: "pending",
            shipmentReferences: ["1001", "1002"],
            batchId: "batch_456",
            message: "EasyPost is still generating the combined batch PDF.",
          },
          results: [
            {
              reference: "1001",
              orderNumbers: ["1001"],
              status: "purchased",
            },
            {
              reference: "1002",
              orderNumbers: ["1002"],
              status: "failed",
              error: "No matching rate",
            },
          ],
        }),
      });

      const requestBody = createValidRequestBody();
      requestBody.shipments.push({
        ...requestBody.shipments[0],
        shipment: {
          ...requestBody.shipments[0].shipment,
          reference: "1002",
          options: {
            ...requestBody.shipments[0].shipment.options,
            invoice_number: "1002",
          },
        },
        orderNumbers: ["1002"],
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/postages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.deepEqual(parsed.body, {
        mode: "test",
        batchLabel: {
          status: "pending",
          shipmentReferences: ["1001", "1002"],
          batchId: "batch_456",
          message: "EasyPost is still generating the combined batch PDF.",
        },
        results: [
          {
            reference: "1001",
            orderNumbers: ["1001"],
            status: "purchased",
          },
          {
            reference: "1002",
            orderNumbers: ["1002"],
            status: "failed",
            error: "No matching rate",
          },
        ],
      });
    },
  },
  {
    name: "shipping postage route rejects invalid payloads",
    run: async () => {
      let purchaseCalled = false;
      const action = createShippingPostagesAction({
        getShippingExportConfig: async () => DEFAULT_SHIPPING_EXPORT_CONFIG,
        purchaseShippingPostages: async () => {
          purchaseCalled = true;
          return {
            mode: "test",
            batchLabel: {
              status: "skipped",
              shipmentReferences: [],
              message:
                "No purchased EasyPost shipments were available to combine into a batch PDF.",
            },
            results: [],
          };
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/postages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labelSize: "invalid", shipments: [] }),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 400);
      assert.deepEqual(parsed.body, {
        error: "labelSize must be one of 4x6, 7x3, or 6x4.",
      });
      assert.equal(purchaseCalled, false);
    },
  },
  {
    name: "shipping postage route returns 500 when purchase execution fails",
    run: async () => {
      const action = createShippingPostagesAction({
        getShippingExportConfig: async () => DEFAULT_SHIPPING_EXPORT_CONFIG,
        purchaseShippingPostages: async () => {
          throw new Error("Missing EASYPOST_TEST_API_KEY");
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/postages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createValidRequestBody()),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 500);
      assert.deepEqual(parsed.body, {
        error: "Error: Missing EASYPOST_TEST_API_KEY",
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
  console.log(`Passed ${testCases.length} shipping postage route tests.`);
}
