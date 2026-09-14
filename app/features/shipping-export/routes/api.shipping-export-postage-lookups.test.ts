import assert from "node:assert/strict";
import { createShippingPostageLookupsAction } from "./api.shipping-export-postage-lookups.server";
import type { ShippingPostagePurchaseRecord } from "~/core/db/repositories/shippingPostagePurchases.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

function createPurchasedRecord(
  overrides: Partial<ShippingPostagePurchaseRecord> = {},
): ShippingPostagePurchaseRecord {
  return {
    id: 1,
    shipmentReference: "1001",
    orderNumbers: ["1001"],
    mode: "production",
    direction: "outbound",
    labelSize: "4x6",
    easypostShipmentId: "shp_123",
    trackingCode: "9400100000000000000000",
    selectedRateService: "GroundAdvantage",
    selectedRateRate: "4.11",
    selectedRateCurrency: "USD",
    labelUrl: "https://example.com/label.png",
    labelPdfUrl: "https://example.com/label.pdf",
    status: "purchased",
    errorMessage: null,
    createdAt: new Date("2026-04-11T00:00:00Z"),
    ...overrides,
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
    name: "shipping postage lookup returns matched purchased labels",
    run: async () => {
      let capturedOrderNumbers: string[] = [];
      const action = createShippingPostageLookupsAction({
        postagePurchasesRepository: {
          async findLatestSuccessfulByOrderNumbers(_direction, orderNumbers) {
            capturedOrderNumbers = orderNumbers;
            return [createPurchasedRecord()];
          },
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/postage-lookups",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              shipments: [
                {
                  shipmentReference: "1001",
                  orderNumbers: ["1001"],
                },
              ],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.deepEqual(capturedOrderNumbers, ["1001"]);
      assert.deepEqual(parsed.body, {
        direction: "outbound",
        results: [
          {
            shipmentReference: "1001",
            mode: "production",
            direction: "outbound",
            labelSize: "4x6",
            purchasedAt: "2026-04-11T00:00:00.000Z",
            result: {
              reference: "1001",
              orderNumbers: ["1001"],
              status: "purchased",
              easypostShipmentId: "shp_123",
              trackingCode: "9400100000000000000000",
              selectedRate: {
                service: "GroundAdvantage",
                rate: "4.11",
                currency: "USD",
              },
              labelUrl: "https://example.com/label.png",
              labelPdfUrl: "https://example.com/label.pdf",
            },
          },
        ],
      });
    },
  },
  {
    name: "shipping postage lookup requires exact order set for merged shipments",
    run: async () => {
      const action = createShippingPostageLookupsAction({
        postagePurchasesRepository: {
          async findLatestSuccessfulByOrderNumbers() {
            return [
              createPurchasedRecord({
                shipmentReference: "1001",
                orderNumbers: ["1001"],
              }),
            ];
          },
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/postage-lookups",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              shipments: [
                {
                  shipmentReference: "1001",
                  orderNumbers: ["1001", "1002"],
                },
              ],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.deepEqual(parsed.body, {
        direction: "outbound",
        results: [],
      });
    },
  },
  {
    name: "shipping postage lookup uses the latest exact-order match",
    run: async () => {
      const action = createShippingPostageLookupsAction({
        postagePurchasesRepository: {
          async findLatestSuccessfulByOrderNumbers() {
            return [
              createPurchasedRecord({
                id: 2,
                mode: "test",
                labelPdfUrl: "https://example.com/newest.pdf",
                orderNumbers: ["1001", "1002"],
              }),
              createPurchasedRecord({
                id: 1,
                mode: "production",
                labelPdfUrl: "https://example.com/older.pdf",
                orderNumbers: ["1001", "1002"],
              }),
            ];
          },
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/postage-lookups",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              shipments: [
                {
                  shipmentReference: "1001",
                  orderNumbers: ["1002", "1001"],
                },
              ],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.equal(
        (parsed.body as { results: Array<{ mode: string; result: { labelPdfUrl?: string } }> }).results[0].mode,
        "test",
      );
      assert.equal(
        (parsed.body as { results: Array<{ mode: string; result: { labelPdfUrl?: string } }> }).results[0].result.labelPdfUrl,
        "https://example.com/newest.pdf",
      );
    },
  },
  {
    name: "shipping postage lookup queries return labels when direction is return",
    run: async () => {
      let capturedDirection: string | null = null;
      const action = createShippingPostageLookupsAction({
        postagePurchasesRepository: {
          async findLatestSuccessfulByOrderNumbers(direction) {
            capturedDirection = direction;
            return [
              createPurchasedRecord({
                direction: "return",
                labelPdfUrl: "https://example.com/return.pdf",
              }),
            ];
          },
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/postage-lookups",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              direction: "return",
              shipments: [
                {
                  shipmentReference: "1001",
                  orderNumbers: ["1001"],
                },
              ],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      const body = parsed.body as {
        direction: string;
        results: Array<{ direction: string; result: { labelPdfUrl?: string } }>;
      };
      assert.equal(parsed.status, 200);
      assert.equal(capturedDirection, "return");
      assert.equal(body.direction, "return");
      assert.equal(body.results[0].direction, "return");
      assert.equal(body.results[0].result.labelPdfUrl, "https://example.com/return.pdf");
    },
  },
  {
    name: "shipping postage lookup rejects unknown directions",
    run: async () => {
      const action = createShippingPostageLookupsAction({
        postagePurchasesRepository: {
          async findLatestSuccessfulByOrderNumbers() {
            return [];
          },
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/postage-lookups",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              direction: "sideways",
              shipments: [{ shipmentReference: "1001", orderNumbers: ["1001"] }],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 400);
      assert.deepEqual(parsed.body, {
        error: "direction must be either outbound or return.",
      });
    },
  },
  {
    name: "shipping postage lookup rejects invalid payloads",
    run: async () => {
      const action = createShippingPostageLookupsAction({
        postagePurchasesRepository: {
          async findLatestSuccessfulByOrderNumbers() {
            return [];
          },
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/postage-lookups",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              shipments: [
                {
                  shipmentReference: "",
                  orderNumbers: [],
                },
              ],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 400);
      assert.deepEqual(parsed.body, {
        error:
          "Each shipment lookup must include a shipmentReference and one or more order numbers.",
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
  console.log(`Passed ${testCases.length} shipping postage lookup tests.`);
}
