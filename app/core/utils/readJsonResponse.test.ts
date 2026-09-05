import assert from "node:assert/strict";
import { readJsonResponse, readResponseError } from "./readJsonResponse";

type TestCase = {
  name: string;
  run: () => Promise<void>;
};

const testCases: TestCase[] = [
  {
    name: "readJsonResponse returns the parsed payload for a successful JSON response",
    run: async () => {
      const response = new Response(JSON.stringify({ results: [1, 2] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

      const payload = await readJsonResponse<{ results: number[] }>(response, "Failed.");

      assert.deepEqual(payload, { results: [1, 2] });
    },
  },
  {
    name: "readJsonResponse names the HTTP status when a gateway returns an empty body",
    run: async () => {
      const response = new Response(null, { status: 502, statusText: "Bad Gateway" });

      await assert.rejects(
        readJsonResponse(response, "Failed to apply tracking."),
        (error: Error) => {
          assert.match(error.message, /Failed to apply tracking\./);
          assert.match(error.message, /HTTP 502 Bad Gateway/);
          assert.match(error.message, /empty response/);
          return true;
        },
      );
    },
  },
  {
    name: "readJsonResponse prefers the error message from a JSON error payload",
    run: async () => {
      const response = new Response(
        JSON.stringify({ error: "updates must be a non-empty array." }),
        { status: 400 },
      );

      await assert.rejects(
        readJsonResponse(response, "Failed to apply tracking."),
        /updates must be a non-empty array\./,
      );
    },
  },
  {
    name: "readJsonResponse names the HTTP status for a non-JSON error body",
    run: async () => {
      const response = new Response("<html>Gateway Timeout</html>", {
        status: 504,
        statusText: "Gateway Timeout",
      });

      await assert.rejects(
        readJsonResponse(response, "Failed to send messages."),
        (error: Error) => {
          assert.equal(
            error.message,
            "Failed to send messages. The server returned HTTP 504 Gateway Timeout.",
          );
          return true;
        },
      );
    },
  },
  {
    name: "readJsonResponse rejects a successful response without a JSON object",
    run: async () => {
      await assert.rejects(
        readJsonResponse(new Response("", { status: 200 }), "Failed to load postage."),
        /unreadable response \(HTTP 200\)/,
      );
      await assert.rejects(
        readJsonResponse(new Response("null", { status: 200 }), "Failed to load postage."),
        /unreadable response \(HTTP 200\)/,
      );
      await assert.rejects(
        readJsonResponse(new Response("false", { status: 200 }), "Failed to load postage."),
        /unreadable response \(HTTP 200\)/,
      );
      await assert.rejects(
        readJsonResponse(new Response("[]", { status: 200 }), "Failed to load postage."),
        /unreadable response \(HTTP 200\)/,
      );
    },
  },
  {
    name: "readResponseError uses the payload error or the HTTP status",
    run: async () => {
      assert.equal(
        await readResponseError(
          new Response(JSON.stringify({ error: "No orders matched." }), { status: 404 }),
          "Failed to export.",
        ),
        "No orders matched.",
      );
      assert.equal(
        await readResponseError(
          new Response(null, { status: 502, statusText: "Bad Gateway" }),
          "Failed to export.",
        ),
        "Failed to export. The server returned HTTP 502 Bad Gateway with an empty response, so the request may not have reached the app. Check that the app is running and try again.",
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
  console.log(`Passed ${testCases.length} JSON response reader tests.`);
}
