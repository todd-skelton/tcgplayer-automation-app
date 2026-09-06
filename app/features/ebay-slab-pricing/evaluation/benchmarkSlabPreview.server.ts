// Explicit local benchmark only: all mutations use an isolated development schema; provider responses are fixture-backed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import Papa from "papaparse";
import fixture from "./fixtures/pokebash-preview-sample.json";
import salesFixture from "../evidence/fixtures/alt-sales.json";
import { parseAltSales } from "../evidence/altEvidenceProvider.server";
import { getPool } from "~/core/db/database.server";
import { parseInventoryCsv } from "../inventory/slabInventoryCsv.server";
import {
  getInventory,
  reconcileInventory,
} from "../inventory/slabInventory.server";
import {
  requestEvidence,
  claimEvidenceJob,
  getEvidenceRevision,
  completeEvidenceJob,
} from "../evidence/evidenceRefreshStore.server";
import type { EvidenceSpec } from "../evidence/evidenceRefresh";
dotenv.config({
  path: [".env.development.local", ".env.local", ".env.development", ".env"],
  quiet: true,
});
const url = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation",
);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.port === "5433" &&
    url.pathname === "/tcgplayer_automation",
  "Benchmark only the configured local development database",
);
const schema = `slab_benchmark_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool(),
  originalFetch = globalThis.fetch;
const originalQuery = db.query;
let poolQueryCalls = 0;
db.query = function (this: typeof db, ...args: any[]) {
  poolQueryCalls++;
  return Reflect.apply(originalQuery, this, args);
} as typeof db.query;
let remoteAttempts = 0;
globalThis.fetch = async () => {
  remoteAttempts++;
  throw new Error("No provider/network requests are allowed in this benchmark");
};
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const timings = async (count: number, fn: () => Promise<unknown>) => {
  const values: number[] = [];
  const queriesBefore = poolQueryCalls;
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await fn();
    values.push(performance.now() - start);
  }
  return {
    samples: count,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    pooledQueriesPerSample: (poolQueryCalls - queriesBefore) / count,
  };
};
try {
  for (const file of [
    "025_add_slab_identities.sql",
    "026_add_slab_inventory.sql",
    "027_add_slab_evidence_refreshes.sql",
    "028_add_slab_comp_decisions.sql",
    "029_add_slab_recommendations.sql",
    "030_add_slab_supply_observations.sql",
    "031_add_slab_publication_previews.sql",
  ])
    await db.query(await readFile(`db/migrations/${file}`, "utf8"));
  const csv = Papa.unparse(
    fixture.listings.map((r) => ({
      item_id: r.itemId,
      title: r.title,
      price: r.askingPriceUsd,
      currency: "USD",
      quantity: 1,
      state: "active",
      format: "fixed-price",
    })),
  );
  let start = performance.now();
  await reconcileInventory(parseInventoryCsv(csv, "acceptance-fixture"), 0);
  const import50Ms = performance.now() - start;
  const read50 = async () => {
    const a = await getInventory("acceptance-fixture", "", 25),
      b = await getInventory("acceptance-fixture", a.next!, 25);
    assert.equal(a.items.length + b.items.length, 50);
    assert.ok([...a.items, ...b.items].every((r) => !r.identity));
  };
  await read50();
  const inventory50 = await timings(30, read50);
  const window = { from: "2023-01-01", to: "2026-09-05" };
  const base = parseAltSales(
    JSON.stringify(salesFixture),
    "cd3ecabf-7d43-4375-9428-1a7cdfe66426",
    window,
    16,
    new Date().toISOString(),
  );
  const workload: EvidenceSpec[] = Array.from({ length: 50 }, (_, i) => ({
    kind: "alt-sales",
    assetId: `benchmark-card-${Math.floor(i / 5)}`,
    window,
    limitPerGrade: 16,
  }));
  start = performance.now();
  const statuses = await requestEvidence(workload);
  assert.equal(statuses.length, 10);
  let fixtureWorkflows = 0;
  while (true) {
    const job = await claimEvidenceJob();
    if (!job) break;
    assert.ok(job.spec.kind === "alt-sales");
    fixtureWorkflows++;
    await completeEvidenceJob(
      job,
      {
        kind: "alt-sales",
        data: {
          ...base,
          sales: base.sales.map((r) => ({
            ...r,
            assetId: (job.spec as Extract<EvidenceSpec, { kind: "alt-sales" }>)
              .assetId,
          })),
        },
      },
      0,
    );
  }
  const coldFixtureRefreshMs = performance.now() - start;
  assert.equal(fixtureWorkflows, 10);
  const warmEvidence = await timings(30, async () => {
    const rows = await requestEvidence(workload);
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => !r.stale));
    assert.equal(await claimEvidenceJob(), null);
  });
  const evidencePages = await timings(30, async () => {
    for (const status of statuses) {
      const row = await getEvidenceRevision(status.runId);
      assert.ok(row);
    }
  });
  const large = parseInventoryCsv(
    Papa.unparse(
      Array.from({ length: 5000 }, (_, i) => ({
        item_id: String(800000000000 + i),
        title: `Synthetic inventory row ${i}`,
        price: 100,
        currency: "USD",
        quantity: 1,
        state: "active",
        format: "fixed-price",
      })),
    ),
    "large-fixture",
  );
  start = performance.now();
  await reconcileInventory(large, 0);
  const import5000Ms = performance.now() - start;
  const largePage = await timings(30, async () => {
    assert.equal(
      (await getInventory("large-fixture", "", 25)).items.length,
      25,
    );
  });
  const storage = (
    await db.query<{ bytes: string }>(
      "SELECT sum(pg_total_relation_size(c.oid))::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'",
      [schema],
    )
  ).rows[0].bytes;
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    scope:
      "Local isolated PostgreSQL feature benchmark. HTTP/provider latency and accepted comp precision are not measured.",
    historicalSample: {
      listings: fixture.listings.length,
      researchQueries: new Set(fixture.listings.map((r) => r.researchQuery))
        .size,
      emptySearches: fixture.listings.filter((r) => r.visibleSoldRows === 0)
        .length,
      visibleSoldRows: fixture.listings.reduce(
        (sum, r) => sum + r.visibleSoldRows,
        0,
      ),
      confirmedIdentityCoverage: null,
      acceptedCompPrecision: null,
      priceError: null,
    },
    import50Ms,
    inventory50,
    coldFixtureRefreshMs,
    fixtureWorkflows,
    warmEvidence,
    evidencePages,
    import5000Ms,
    largePage,
    databaseBytes: Number(storage),
    processMemory: process.memoryUsage(),
    remoteAttempts,
    gates: {
      zeroRemoteRequests: remoteAttempts === 0,
      coalescedGroups: fixtureWorkflows === 10,
      maximumInventoryPage: 25,
      automationEnabled: false,
    },
  };
  assert.equal(remoteAttempts, 0);
  await writeFile(
    "docs/slab-preview-benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
