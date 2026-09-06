import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const [baselineUrl, currentUrl] = process.argv.slice(2);
for (const address of [baselineUrl, currentUrl]) {
  const url = new URL(address);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.protocol === "http:",
    "Benchmark local validation servers only",
  );
}
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
async function read(address, route) {
  const start = performance.now(),
    response = await fetch(new URL(route, address), {
      signal: AbortSignal.timeout(10000),
    });
  const body = await response.text();
  assert.equal(response.status, 200, `${route} must render`);
  return { ms: performance.now() - start, bytes: Buffer.byteLength(body) };
}
const results = {};
for (const route of ["/", "/pricer", "/pending-inventory-pricer"]) {
  for (let i = 0; i < 5; i++) {
    await read(baselineUrl, route);
    await read(currentUrl, route);
  }
  const before = [],
    after = [];
  for (let i = 0; i < 50; i++) {
    // Alternate order to reduce warm-up and scheduling bias.
    if (i % 2) {
      after.push(await read(currentUrl, route));
      before.push(await read(baselineUrl, route));
    } else {
      before.push(await read(baselineUrl, route));
      after.push(await read(currentUrl, route));
    }
  }
  const describe = (rows) => ({
    samples: rows.length,
    p50Ms: percentile(
      rows.map((r) => r.ms),
      0.5,
    ),
    p95Ms: percentile(
      rows.map((r) => r.ms),
      0.95,
    ),
    responseBytes: rows.at(-1).bytes,
  });
  results[route] = { before: describe(before), after: describe(after) };
}
const newRoutes = {};
for (const route of [
  "/slab-pricing",
  "/slab-connections",
  "/api/slab-inventory?seller=acceptance-fixture&limit=25",
]) {
  const first = await read(currentUrl, route),
    rows = [];
  for (let i = 0; i < 30; i++) rows.push(await read(currentUrl, route));
  newRoutes[route] = {
    firstRequestMs: first.ms,
    p50Ms: percentile(
      rows.map((r) => r.ms),
      0.5,
    ),
    p95Ms: percentile(
      rows.map((r) => r.ms),
      0.95,
    ),
  };
}
const report = {
  measuredAt: new Date().toISOString(),
  scope:
    "Local Docker Node 20 production builds on fresh empty databases, no provider credentials. HTTP render latency only; network market latency and production job contention are unmeasured.",
  results,
  newRoutes,
};
await writeFile(
  "docs/slab-preview-http.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
