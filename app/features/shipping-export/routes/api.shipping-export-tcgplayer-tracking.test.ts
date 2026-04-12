import assert from "node:assert/strict";
import { createShippingTcgplayerTrackingAction } from "./api.shipping-export-tcgplayer-tracking.server";

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
    name: "shipping tcgplayer tracking route rejects non-post methods",
    run: async () => {
      const action = createShippingTcgplayerTrackingAction();

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/tcgplayer-tracking",
          { method: "GET" },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 405);
      assert.deepEqual(parsed.body, { error: "Method not allowed" });
    },
  },
  {
    name: "shipping tcgplayer tracking route applies tracking updates",
    run: async () => {
      let capturedUpdates: Array<{
        orderNumber: string;
        carrier: string;
        trackingNumber: string;
      }> = [];
      const action = createShippingTcgplayerTrackingAction({
        applyTrackingToSellerOrders: async (updates) => {
          capturedUpdates = updates;

          return {
            results: updates.map((update) => ({
              ...update,
              status: "applied" as const,
            })),
          };
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/tcgplayer-tracking",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              updates: [
                {
                  orderNumber: "8520A14F-B36F57-455F9",
                  carrier: "USPS",
                  trackingNumber: "9400136208303483626879",
                },
              ],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.deepEqual(capturedUpdates, [
        {
          orderNumber: "8520A14F-B36F57-455F9",
          carrier: "USPS",
          trackingNumber: "9400136208303483626879",
        },
      ]);
      assert.deepEqual(parsed.body, {
        results: [
          {
            orderNumber: "8520A14F-B36F57-455F9",
            carrier: "USPS",
            trackingNumber: "9400136208303483626879",
            status: "applied",
          },
        ],
      });
    },
  },
  {
    name: "shipping tcgplayer tracking route rejects invalid payloads",
    run: async () => {
      const action = createShippingTcgplayerTrackingAction({
        applyTrackingToSellerOrders: async () => {
          throw new Error("should not be called");
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/tcgplayer-tracking",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              updates: [
                {
                  orderNumber: "8520A14F-B36F57-455F9",
                  carrier: "",
                  trackingNumber: "9400136208303483626879",
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
          "Each tracking update must include an orderNumber, carrier, and trackingNumber.",
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
  console.log(`Passed ${testCases.length} shipping tcgplayer tracking route tests.`);
}
