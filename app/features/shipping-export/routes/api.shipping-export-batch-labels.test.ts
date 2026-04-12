import assert from "node:assert/strict";
import { createShippingBatchLabelsAction } from "./api.shipping-export-batch-labels.server";

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
    name: "shipping batch labels route returns a generated batch pdf",
    run: async () => {
      let capturedMode: string | null = null;
      let capturedShipments: Array<{ shipmentReference: string; easypostShipmentId: string }> =
        [];
      const action = createShippingBatchLabelsAction({
        generateBatchLabelForPurchasedShipments: async (mode, shipments) => {
          capturedMode = mode;
          capturedShipments = shipments;
          return {
            status: "ready",
            shipmentReferences: shipments.map((shipment) => shipment.shipmentReference),
            batchId: "batch_123",
            labelUrl: "https://example.com/batch.pdf",
          };
        },
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/batch-labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "production",
            labelSize: "4x6",
            shipments: [
              {
                shipmentReference: "1001",
                easypostShipmentId: "shp_123",
              },
            ],
          }),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.equal(capturedMode, "production");
      assert.deepEqual(capturedShipments, [
        {
          shipmentReference: "1001",
          easypostShipmentId: "shp_123",
        },
      ]);
      assert.deepEqual(parsed.body, {
        status: "ready",
        shipmentReferences: ["1001"],
        batchId: "batch_123",
        labelUrl: "https://example.com/batch.pdf",
      });
    },
  },
  {
    name: "shipping batch labels route rejects invalid payloads",
    run: async () => {
      const action = createShippingBatchLabelsAction({
        generateBatchLabelForPurchasedShipments: async () => ({
          status: "ready",
          shipmentReferences: [],
        }),
      });

      const result = await action({
        request: new Request("http://localhost/api/shipping-export/batch-labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "invalid",
            labelSize: "4x6",
            shipments: [],
          }),
        }),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 400);
      assert.deepEqual(parsed.body, {
        error: "mode must be test or production.",
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
  console.log(`Passed ${testCases.length} shipping batch label route tests.`);
}
