import assert from "node:assert/strict";
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
const [baseline, current] = process.argv.slice(2);
assert.ok(
  baseline && current,
  "Provide baseline and current build directories",
);
async function inspect(directory) {
  const assets = path.join(directory, "client/assets"),
    files = await readdir(assets);
  const manifestFile = files.find((file) => /^manifest-.*\.js$/.test(file));
  assert.ok(manifestFile);
  const text = await readFile(path.join(assets, manifestFile), "utf8");
  const prefix = "window.__reactRouterManifest=";
  assert.ok(text.startsWith(prefix));
  const manifest = JSON.parse(text.slice(prefix.length).replace(/;\s*$/, ""));
  const size = async (url) =>
    gzipSync(await readFile(path.join(directory, "client", url))).byteLength;
  const entry = manifest.entry,
    root = manifest.routes.root;
  const routes = {};
  for (const routePath of [
    "/pricer",
    "/pending-inventory-pricer",
    "/slab-pricing",
  ]) {
    const route = Object.values(manifest.routes).find(
      (r) => r.path === routePath,
    );
    if (!route) continue;
    const urls = [
      ...new Set([
        entry.module,
        ...entry.imports,
        root.module,
        ...root.imports,
        route.module,
        ...route.imports,
        `/assets/${manifestFile}`,
      ]),
    ];
    routes[routePath] = {
      gzipBytes: (await Promise.all(urls.map(size))).reduce((a, b) => a + b, 0),
      slabModules: urls.filter((url) =>
        /Slab|slabClient|slab-pricing/.test(url),
      ),
    };
  }
  const lazySlab = {};
  for (const file of files.filter((name) =>
    /^Slab(?:CompReview|SupplyPanel|PublicationPreview)-/.test(name),
  ))
    lazySlab[file.split("-")[0]] = await size(`/assets/${file}`);
  const workers = {};
  for (const file of (await readdir(path.join(directory, "workers"))).filter(
    (name) => name.endsWith(".js"),
  ))
    workers[file] = (await stat(path.join(directory, "workers", file))).size;
  return { routes, lazySlab, workers };
}
const before = await inspect(baseline),
  after = await inspect(current);
const deltas = Object.fromEntries(
  ["/pricer", "/pending-inventory-pricer"].map((route) => [
    route,
    after.routes[route].gzipBytes - before.routes[route].gzipBytes,
  ]),
);
for (const route of Object.keys(deltas)) {
  assert.deepEqual(
    after.routes[route].slabModules,
    [],
    "Existing routes must not load slab implementation chunks",
  );
  assert.ok(
    deltas[route] <= 4096,
    "Existing route static gzip growth must stay within the 4 KiB navigation/manifest budget",
  );
}
const report = {
  measuredAt: new Date().toISOString(),
  basis:
    "React Router static entry/root/route imports plus route manifest; gzip per asset. Lazy panel figures exclude shared dependencies.",
  before,
  after,
  deltas,
  gates: { unrelatedSlabModules: 0, unrelatedRouteGrowthBudgetBytes: 4096 },
};
await writeFile(
  "docs/slab-preview-bundles.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
