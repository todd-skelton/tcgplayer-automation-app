import assert from "node:assert/strict";
import { createShippingTcgplayerShippedMessagesAction } from "./api.shipping-export-tcgplayer-shipped-messages.server";

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
    name: "shipping tcgplayer shipped messages route rejects non-post methods",
    run: async () => {
      const action = createShippingTcgplayerShippedMessagesAction();

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/tcgplayer-shipped-messages",
          { method: "GET" },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 405);
      assert.deepEqual(parsed.body, { error: "Method not allowed" });
    },
  },
  {
    name: "shipping tcgplayer shipped messages route sends messages",
    run: async () => {
      let capturedMessages: Array<{
        orderNumber: string;
        sellerKey: string;
        easypostShipmentId: string;
      }> = [];
      const action = createShippingTcgplayerShippedMessagesAction({
        sendShippedMessagesToSellerOrders: async (messages) => {
          capturedMessages = messages;

          return {
            results: messages.map((message) => ({
              ...message,
              trackingUrl: "https://track.easypost.com/example",
              status: "sent" as const,
            })),
          };
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/tcgplayer-shipped-messages",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                {
                  orderNumber: "8520A14F-B36F57-455F9",
                  sellerKey: "8520a14f",
                  easypostShipmentId: "shp_123",
                },
              ],
            }),
          },
        ),
      });

      const parsed = await parseActionResult(result);
      assert.equal(parsed.status, 200);
      assert.deepEqual(capturedMessages, [
        {
          orderNumber: "8520A14F-B36F57-455F9",
          sellerKey: "8520a14f",
          easypostShipmentId: "shp_123",
        },
      ]);
      assert.deepEqual(parsed.body, {
        results: [
          {
            orderNumber: "8520A14F-B36F57-455F9",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_123",
            trackingUrl: "https://track.easypost.com/example",
            status: "sent",
          },
        ],
      });
    },
  },
  {
    name: "shipping tcgplayer shipped messages route rejects invalid payloads",
    run: async () => {
      const action = createShippingTcgplayerShippedMessagesAction({
        sendShippedMessagesToSellerOrders: async () => {
          throw new Error("should not be called");
        },
      });

      const result = await action({
        request: new Request(
          "http://localhost/api/shipping-export/tcgplayer-shipped-messages",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                {
                  orderNumber: "8520A14F-B36F57-455F9",
                  sellerKey: "",
                  easypostShipmentId: "shp_123",
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
          "Each shipped message must include an orderNumber, sellerKey, and easypostShipmentId.",
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
  console.log(
    `Passed ${testCases.length} shipping tcgplayer shipped messages route tests.`,
  );
}
