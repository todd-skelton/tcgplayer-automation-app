import assert from "node:assert/strict";
import { createShippingPullSheetExportAction } from "./api.shipping-export-pull-sheet-export.server";

type TestCase = {
  name: string;
  run: () => Promise<void> | void;
};

const testCases: TestCase[] = [
  {
    name: "shipping pull sheet export rejects non-post methods",
    run: async () => {
      const action = createShippingPullSheetExportAction();

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/pull-sheet-export",
          { method: "GET" },
        ),
      });

      assert.equal(response.status, 405);
      assert.deepEqual(await response.json(), { error: "Method not allowed" });
    },
  },
  {
    name: "shipping pull sheet export validates order numbers",
    run: async () => {
      const action = createShippingPullSheetExportAction({
        exportPullSheet: async () => "should not be called",
      });

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/pull-sheet-export",
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
    name: "shipping pull sheet export validates timezone offset",
    run: async () => {
      const action = createShippingPullSheetExportAction({
        exportPullSheet: async () => "should not be called",
      });

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/pull-sheet-export",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderNumbers: ["1001"], timezoneOffset: "bad" }),
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
    name: "shipping pull sheet export returns csv text",
    run: async () => {
      let capturedPayload: { orderNumbers: string[]; timezoneOffset: number } | null =
        null;

      const action = createShippingPullSheetExportAction({
        exportPullSheet: async (payload) => {
          capturedPayload = payload;
          return "SkuId,Product Name\n1,Card";
        },
      });

      const response = await action({
        request: new Request(
          "http://localhost/api/shipping-export/pull-sheet-export",
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
      assert.equal(response.headers.get("Content-Type"), "text/csv; charset=utf-8");
      assert.equal(await response.text(), "SkuId,Product Name\n1,Card");
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
  console.log(`Passed ${testCases.length} shipping pull sheet export tests.`);
}
