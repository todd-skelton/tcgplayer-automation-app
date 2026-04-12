import assert from "node:assert/strict";
import { createShippingPackingSlipsExportAction } from "./api.shipping-export-packing-slips-export.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const testCases: TestCase[] = [
  {
    name: "shipping packing slips export rejects non-post methods",
    run: async () => {
      const action = createShippingPackingSlipsExportAction();

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/packing-slips-export",
          { method: "GET" },
        ),
      });

      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), { error: "Method not allowed" });
    },
  },
  {
    name: "shipping packing slips export validates order numbers",
    run: async () => {
      const action = createShippingPackingSlipsExportAction({
        exportPackingSlips: async () => new Uint8Array([1, 2, 3]),
      });

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/packing-slips-export",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderNumbers: [], timezoneOffset: -5 }),
          },
        ),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "orderNumbers must include at least one order number.",
      });
    },
  },
  {
    name: "shipping packing slips export validates timezone offset",
    run: async () => {
      const action = createShippingPackingSlipsExportAction({
        exportPackingSlips: async () => new Uint8Array([1, 2, 3]),
      });

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/packing-slips-export",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderNumbers: ["1001"],
              timezoneOffset: "bad",
            }),
          },
        ),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "timezoneOffset must be a valid number.",
      });
    },
  },
  {
    name: "shipping packing slips export returns pdf bytes",
    run: async () => {
      let capturedPayload: { orderNumbers: string[]; timezoneOffset: number } | null =
        null;

      const action = createShippingPackingSlipsExportAction({
        exportPackingSlips: async (payload) => {
          capturedPayload = payload;
          return new Uint8Array([37, 80, 68, 70]);
        },
        now: () => new Date("2026-04-12T14:33:12.456Z"),
      });

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/packing-slips-export",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderNumbers: ["1001", "1001", "1002"],
              timezoneOffset: -5,
            }),
          },
        ),
      });

      assert.deepEqual(capturedPayload, {
        orderNumbers: ["1001", "1002"],
        timezoneOffset: -5,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), "application/pdf");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(
        response.headers.get("Content-Disposition"),
        'inline; filename="packing-slips-2026-04-12T14-33-12-456Z.pdf"',
      );
      assert.deepEqual(
        Array.from(new Uint8Array(await response.arrayBuffer())),
        [37, 80, 68, 70],
      );
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
  console.log(`Passed ${testCases.length} shipping packing slips export tests.`);
}
