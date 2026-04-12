import assert from "node:assert/strict";
import { applyTrackingToSellerOrders } from "./tcgplayerTracking.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const testCases: TestCase[] = [
  {
    name: "applyTrackingToSellerOrders applies each unique order once",
    run: async () => {
      const capturedCalls: Array<{
        orderNumber: string;
        carrier: string;
        trackingNumber: string;
      }> = [];

      const response = await applyTrackingToSellerOrders(
        [
          {
            orderNumber: "1001",
            carrier: "USPS",
            trackingNumber: "9400",
          },
          {
            orderNumber: "1001",
            carrier: "USPS",
            trackingNumber: "9400",
          },
          {
            orderNumber: "1002",
            carrier: "USPS",
            trackingNumber: "9401",
          },
        ],
        {
          applyTracking: async (orderNumber, request) => {
            capturedCalls.push({
              orderNumber,
              carrier: request.carrier,
              trackingNumber: request.trackingNumber,
            });
          },
        },
      );

      assert.deepEqual(capturedCalls, [
        {
          orderNumber: "1001",
          carrier: "USPS",
          trackingNumber: "9400",
        },
        {
          orderNumber: "1002",
          carrier: "USPS",
          trackingNumber: "9401",
        },
      ]);
      assert.deepEqual(response, {
        results: [
          {
            orderNumber: "1001",
            carrier: "USPS",
            trackingNumber: "9400",
            status: "applied",
          },
          {
            orderNumber: "1002",
            carrier: "USPS",
            trackingNumber: "9401",
            status: "applied",
          },
        ],
      });
    },
  },
  {
    name: "applyTrackingToSellerOrders preserves per-order failures",
    run: async () => {
      const response = await applyTrackingToSellerOrders(
        [
          {
            orderNumber: "1001",
            carrier: "USPS",
            trackingNumber: "9400",
          },
          {
            orderNumber: "1002",
            carrier: "USPS",
            trackingNumber: "9401",
          },
        ],
        {
          applyTracking: async (orderNumber) => {
            if (orderNumber === "1002") {
              throw new Error("403 Forbidden");
            }
          },
        },
      );

      assert.deepEqual(response, {
        results: [
          {
            orderNumber: "1001",
            carrier: "USPS",
            trackingNumber: "9400",
            status: "applied",
          },
          {
            orderNumber: "1002",
            carrier: "USPS",
            trackingNumber: "9401",
            status: "failed",
            error: "Error: 403 Forbidden",
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
  console.log(`Passed ${testCases.length} TCGPlayer tracking service tests.`);
}
