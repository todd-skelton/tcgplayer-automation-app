// Records what Node's slab evidence queue, worker job and supply scans answer and write, for the
// Rust ports to be checked against (`slab_evidence::store`'s `the_queue_runs_as_node_runs_it`,
// `slab_evidence::worker`'s `refreshes_run_as_node_runs_them`, `slab_evidence::supply`'s
// `scans_are_recorded_as_node_records_them`). Each scenario starts from empty slab tables in a
// throwaway database holding only the dev database's schema, and is read back with
// tests/fixtures/node/slab/capture.sql, the query the Rust tests read theirs with.
//
//   node scripts/parity/slab-evidence.mjs
//
// (which makes the database, runs this with vite-node against it, and drops it). No provider is
// called: every answer is built from the committed provider fixtures.
import { readFileSync, writeFileSync } from "node:fs";
import { parseAltSaleDetail, parseAltSales, parseAltSupply } from "../../app/features/ebay-slab-pricing/evidence/altEvidenceProvider.server";
import { evidenceKey } from "../../app/features/ebay-slab-pricing/evidence/evidenceRefreshProvider.server";
import { normalizeEvidenceSpec } from "../../app/features/ebay-slab-pricing/evidence/evidenceRefresh";
import {
  cancelEvidenceRefresh,
  claimEvidenceJob,
  completeEvidenceJob,
  evidenceStatuses,
  failEvidenceJob,
  requestEvidence,
} from "../../app/features/ebay-slab-pricing/evidence/evidenceRefreshStore.server";
import { runEvidenceJob } from "../../app/features/ebay-slab-pricing/evidence/evidenceRefreshWorker.server";
import { recordSupplyScan } from "../../app/features/ebay-slab-pricing/supply/supplyObservations.server";
import { ProviderRequestError } from "../../app/features/ebay-slab-pricing/connections/providerRequest.server";
import { getPool } from "../../app/core/db/database.server";

if (!process.env.DATABASE_URL?.endsWith("/slab_parity")) throw new Error("Run through scripts/parity/slab-evidence.mjs");
const OUT = "tests/fixtures/node/slab";
const FIXTURES = "app/features/ebay-slab-pricing/evidence/fixtures";
const fixture = (name: string) => JSON.parse(readFileSync(`${FIXTURES}/${name}`, "utf8"));
const capture = readFileSync(`${OUT}/capture.sql`, "utf8");
const pool = getPool();
const captured = async () => (await pool.query(`SELECT captured FROM (${capture}) AS c`)).rows[0].captured;
const empty = () =>
  pool.query("TRUNCATE slab_supply_observations, slab_supply_versions, slab_evidence_revisions, slab_supply_scans, slab_evidence_refreshes CASCADE");
const brief = (rows: { key: string; state: string; stale: boolean; attempts: number; errorCode: string | null }[]) =>
  rows.map((s) => ({ key: s.key, state: s.state, stale: s.stale, attempts: s.attempts, error: s.errorCode }));

// The answers a provider gives, built from the fixtures.
const window = { from: "2025-10-30", to: "2026-10-30" };
const asOf = "2026-10-30T12:00:00.000Z";
const sales = fixture("alt-sales.json");
sales.data.asset.id = "asset-1";
const detail = fixture("alt-sale-detail.json");
detail.data.externalTransaction.id = "tx-9";
const scenario = {
  detail: { kind: "alt-sale-detail", data: parseAltSaleDetail(JSON.stringify(detail), "tx-9") },
  sales: { kind: "alt-sales", data: parseAltSales(JSON.stringify(sales), "asset-1", window, 16, asOf) },
};
const ebay = (offset: number) => ({
  groupKey: "ab".repeat(32),
  keywords: "PSA 10 Charizard Base Set",
  window,
  offset,
  limit: 50,
  timezone: "America/Chicago",
});

// The queue: requests, claims, two saved, a retry, a failure, a cancel, a forced request.
await empty();
const specs = [
  { kind: "alt-sales", assetId: "asset-1", window, limitPerGrade: 16 },
  { kind: "alt-supply", assetId: "asset-1" },
  { kind: "alt-sale-detail", transactionId: "tx-9" },
  { kind: "ebay-sales", ...ebay(0) },
  { kind: "ebay-supply", ...ebay(50) },
] as const;
const keys = specs.map((s) => evidenceKey(s as never));
const queue: unknown[] = [];
queue.push(brief(await requestEvidence(specs as never, { priority: 200 })));
queue.push(brief(await requestEvidence([specs[2], specs[3]] as never, { priority: 250 })));
const first = (await claimEvidenceJob())!;
queue.push({ claimed: first.key, attempts: first.attempts, saved: await completeEvidenceJob(first, scenario.detail as never, 1234.4) });
const second = (await claimEvidenceJob())!;
await failEvidenceJob(second, "busy", true);
queue.push({ claimed: second.key, attempts: second.attempts });
const third = (await claimEvidenceJob())!;
queue.push({ claimed: third.key, saved: await completeEvidenceJob(third, scenario.sales as never, 87.6) });
const fourth = (await claimEvidenceJob())!;
await failEvidenceJob(fourth, "weird-code", false);
queue.push({ claimed: fourth.key });
const [supplyStatus] = await evidenceStatuses(keys.slice(4));
queue.push({ cancelled: (await cancelEvidenceRefresh(keys[4], supplyStatus.runId)).map((r) => String(r.key)) });
queue.push(brief(await requestEvidence(specs.slice(0, 1) as never, { priority: 100 })));
queue.push(brief(await requestEvidence(specs.slice(1, 2) as never, { priority: 100, force: true })));
queue.push({ next: (await claimEvidenceJob())?.key ?? null });
queue.push(brief(await evidenceStatuses(keys)));
const queueRun = { steps: queue, captured: await captured() };

// The worker: two saved, one refused for the wrong asset, a rate limit, a cancelled read, and one
// that never answers before its run is stopped.
await empty();
const workSpecs = [
  { kind: "alt-sale-detail", transactionId: "tx-9" },
  { kind: "alt-sales", assetId: "asset-1", window, limitPerGrade: 16 },
  { kind: "ebay-sales", ...ebay(0) },
  { kind: "ebay-supply", ...ebay(50) },
  { kind: "alt-sales", assetId: "asset-2", window, limitPerGrade: 16 },
  { kind: "alt-sale-detail", transactionId: "tx-10" },
];
const standIn = (spec: { kind: string; transactionId?: string }, signal: AbortSignal) => {
  if (spec.kind === "alt-sale-detail" && spec.transactionId === "tx-9") return Promise.resolve(scenario.detail);
  if (spec.kind === "alt-sales") return Promise.resolve(scenario.sales);
  if (spec.kind === "ebay-sales") return Promise.reject(new ProviderRequestError("rate-limited"));
  if (spec.kind === "ebay-supply") return Promise.reject(new ProviderRequestError("cancelled"));
  return new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(new ProviderRequestError("cancelled")), { once: true }),
  );
};
await requestEvidence(workSpecs as never, { priority: 200 });
const work: unknown[] = [];
for (let job = await claimEvidenceJob(); job; job = await claimEvidenceJob()) {
  const saved = await runEvidenceJob(job, { fetch: standIn as never, signal: AbortSignal.timeout(300) });
  work.push({ key: job.key, kind: job.spec.kind, saved });
}
const workerRun = { steps: work, captured: await captured() };

// Supply scans: a copy collapsed, the same scan again, changed content under one run, reordered
// and changed listings, contradictory copies, the wrong source, an eBay scan, an unchanged scan
// copied; then a supply refresh completed.
await empty();
const listing = (id: string, price: string, grade = "9.0") => ({
  id,
  state: "ACTIVE",
  type: "FIXED_PRICE",
  listPrice: price,
  createdAt: "2026-10-01T00:00:00Z",
  expiresAt: null,
  items: [
    { asset: { id: "asset-1" }, attributes: { gradingCompany: "PSA", gradeNumber: grade } },
    { asset: { id: "asset-1" }, attributes: { gradingCompany: "BGS", gradeNumber: "9.5" } },
  ],
});
const altListings = (asset: string, rows: unknown[]) =>
  parseAltSupply(JSON.stringify({ data: { asset: { id: asset, activeListings: rows } } }), asset);
const altSupply = (at: string, rows: unknown[], asset = "asset-1") => ({
  kind: "alt-supply",
  data: { listings: altListings(asset, rows), asOf: at, scope: "alt-only" },
});
const run = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const altSpec = { kind: "alt-supply", assetId: "asset-1" };
const ebaySpec = { kind: "ebay-supply", ...ebay(0) };
const ebayListing = (id: string, amount: number) => ({
  provider: "ebayResearch",
  providerId: id,
  assetId: null,
  venue: "eBay",
  sourceUrl: `https://www.ebay.com/itm/${id}`,
  format: "FIXED_PRICE",
  state: "ACTIVE",
  price: { amount, currency: "USD" },
  priceKind: "ask",
  shipping: { amount: 0, currency: "USD" },
  quantity: null,
  startedAt: null,
  endsAt: null,
  title: `PSA 10 Charizard ${id}`,
  extendedTitle: null,
  items: [{ assetId: null, grading: { grader: "PSA", encoding: "10", number: 10, label: null, qualifier: null, autograph: null } }],
});
const scans = [
  { spec: altSpec, run: run(1), payload: altSupply("2026-10-01T00:00:00.000Z", [listing("l-1", "100.00"), listing("l-2", "80.00"), listing("l-1", "100.00")]) },
  { spec: altSpec, run: run(1), payload: altSupply("2026-10-01T00:00:00.000Z", [listing("l-1", "100.00"), listing("l-2", "80.00"), listing("l-1", "100.00")]) },
  { spec: altSpec, run: run(1), payload: altSupply("2026-10-01T00:00:00.000Z", [listing("l-1", "100.00")]) },
  { spec: altSpec, run: run(2), payload: altSupply("2026-10-02T00:00:00.000Z", [listing("l-2", "75.00"), listing("l-1", "100.00")]) },
  { spec: altSpec, run: run(3), payload: altSupply("2026-10-03T00:00:00.000Z", [listing("l-1", "100.00"), listing("l-1", "99.00")]) },
  { spec: ebaySpec, run: run(4), payload: altSupply("2026-10-03T00:00:00.000Z", [listing("l-3", "50.00")]) },
  { spec: ebaySpec, run: run(5), payload: { kind: "ebay-supply", data: { listings: [ebayListing("e-1", 410), ebayListing("e-2", 395.5)], asOf: "2026-10-03T00:00:00.000Z" } } },
  { spec: altSpec, run: run(6), payload: altSupply("2026-10-04T00:00:00.000Z", [listing("l-2", "75.00"), listing("l-1", "100.00")]) },
];
const client = await pool.connect();
const supply: unknown[] = [];
try {
  await client.query("BEGIN");
  for (const scan of scans) {
    const spec = normalizeEvidenceSpec(scan.spec as never);
    const job = { key: evidenceKey(spec), spec, runId: scan.run, leaseId: scan.run, attempts: 1 };
    await client.query("SAVEPOINT scan");
    try {
      await recordSupplyScan(client as never, job as never, scan.payload as never);
      await client.query("RELEASE SAVEPOINT scan");
      supply.push({ run: scan.run, ok: true });
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT scan");
      supply.push({ run: scan.run, error: (error as Error).message });
    }
  }
  await client.query("COMMIT");
} finally {
  client.release();
}
const completedSpec = { kind: "alt-supply", assetId: "asset-2" };
const completed = {
  spec: completedSpec,
  payload: {
    kind: "alt-supply",
    data: {
      listings: altListings("asset-2", [{ ...listing("l-9", "60.00"), items: [{ asset: { id: "asset-2" }, attributes: { gradingCompany: "PSA", gradeNumber: "8.0" } }] }]),
      asOf: "2026-10-05T00:00:00.000Z",
      scope: "alt-only",
    },
  },
};
await requestEvidence([completedSpec] as never, { priority: 200 });
const job = (await claimEvidenceJob())!;
supply.push({ completed: job.key, saved: await completeEvidenceJob(job, completed.payload as never, 10) });
const supplyCaptured = JSON.parse(JSON.stringify(await captured()).replaceAll(job.runId, "completed-run"));
const supplyRun = { steps: supply, captured: supplyCaptured };

writeFileSync(`${OUT}/evidence-scenario.json`, JSON.stringify(scenario, null, 1) + "\n");
writeFileSync(`${OUT}/evidence-queue.json`, JSON.stringify(queueRun, null, 1) + "\n");
writeFileSync(`${OUT}/evidence-worker.json`, JSON.stringify(workerRun, null, 1) + "\n");
writeFileSync(`${OUT}/supply-scan-scenario.json`, JSON.stringify({ scans, completed }, null, 1) + "\n");
writeFileSync(`${OUT}/supply-scan.json`, JSON.stringify(supplyRun, null, 1) + "\n");
console.log("queue", JSON.stringify(queue.map((s) => (Array.isArray(s) ? s.map((x) => x.state).join(",") : s))));
console.log("worker", JSON.stringify(work));
console.log("supply", JSON.stringify(supply));
await pool.end();
