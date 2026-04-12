import assert from "node:assert/strict";
import { sendShippedMessagesToSellerOrders } from "./tcgplayerShippedMessages.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const testCases: TestCase[] = [
  {
    name: "sendShippedMessagesToSellerOrders sends each unique order once and reuses tracking lookups",
    run: async () => {
      const sentMessages: Array<{
        sellerKey: string;
        subjectId: string;
        messageBody: string;
        associationType: string;
        associationValue: string;
      }> = [];
      const requestedShipmentIds: string[] = [];

      const response = await sendShippedMessagesToSellerOrders(
        [
          {
            orderNumber: "8520A14F-B36F57-455F9",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_1",
          },
          {
            orderNumber: "8520A14F-B36F57-455F9",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_1",
          },
          {
            orderNumber: "8520A14F-C11111-AAAAA",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_1",
          },
        ],
        {
          createThread: async (request) => {
            sentMessages.push(request);
          },
          getTrackingUrl: async (_mode, easypostShipmentId) => {
            requestedShipmentIds.push(easypostShipmentId);
            return "https://track.easypost.com/public/shp_1";
          },
        },
      );

      assert.deepEqual(requestedShipmentIds, ["shp_1"]);
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0]?.subjectId, "2");
      assert.equal(sentMessages[0]?.associationType, "SellerOrder");
      assert.equal(
        sentMessages[0]?.associationValue,
        "8520A14F-B36F57-455F9",
      );
      assert.match(
        sentMessages[0]?.messageBody ?? "",
        /<a href="https:\/\/track\.easypost\.com\/public\/shp_1">Pok\u00E9Bash TCG Tracking<\/a>/,
      );
      assert.deepEqual(response, {
        results: [
          {
            orderNumber: "8520A14F-B36F57-455F9",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_1",
            trackingUrl: "https://track.easypost.com/public/shp_1",
            status: "sent",
          },
          {
            orderNumber: "8520A14F-C11111-AAAAA",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_1",
            trackingUrl: "https://track.easypost.com/public/shp_1",
            status: "sent",
          },
        ],
      });
    },
  },
  {
    name: "sendShippedMessagesToSellerOrders preserves tracking lookup failures per order",
    run: async () => {
      const response = await sendShippedMessagesToSellerOrders(
        [
          {
            orderNumber: "8520A14F-B36F57-455F9",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_missing",
          },
          {
            orderNumber: "8520A14F-C11111-AAAAA",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_missing",
          },
        ],
        {
          createThread: async () => {
            throw new Error("should not be called");
          },
          getTrackingUrl: async () => {
            throw new Error("Missing EasyPost tracker URL.");
          },
        },
      );

      assert.deepEqual(response, {
        results: [
          {
            orderNumber: "8520A14F-B36F57-455F9",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_missing",
            status: "failed",
            error: "Error: Missing EasyPost tracker URL.",
          },
          {
            orderNumber: "8520A14F-C11111-AAAAA",
            sellerKey: "8520a14f",
            easypostShipmentId: "shp_missing",
            status: "failed",
            error: "Error: Missing EasyPost tracker URL.",
          },
        ],
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
    `Passed ${testCases.length} TCGPlayer shipped message service tests.`,
  );
}
