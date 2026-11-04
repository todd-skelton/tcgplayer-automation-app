// Proves a Rust worker against Node's on copies of the dev database: queues one pricing job in a
// copy (twin_base), copies that twice, lets Node's worker run the job in twin_node and the Rust
// worker in twin_rust, then compares every row either wrote. Neither worker publishes: Seller
// Portal writes stay off and the publication worker is not started.
//
//   node scripts/parity/twin-pricing-worker.mjs <batch> <mode: full|errors|cached>
//
// A cached job prices from saved curves, so both workers must write the same values. A full or
// errors job reads TCGplayer once for each worker, minutes apart, so its numbers may differ as the
// market moved; then only what was written, and every value that is not a number, must match.
//
// Needs the dev database container (tcgplayer-postgres-db) with no other sessions on the dev
// database while it is copied, and a fresh `cargo build`. Drops the copies when done.
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const [batchArg, mode = "cached"] = process.argv.slice(2);
const batch = Number(batchArg);
if (!Number.isInteger(batch) || !["full", "errors", "cached"].includes(mode)) {
  throw new Error("usage: twin-pricing-worker.mjs <batch> <full|errors|cached>");
}
const CONTAINER = "tcgplayer-postgres-db";
const url = (db) => `postgresql://postgres:postgres@localhost:5433/${db}`;
const docker = (...args) => execFileSync("docker", ["exec", CONTAINER, ...args], { maxBuffer: 1e9 }).toString();
const sql = (db, text) => docker("psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", text);
const rows = (db, text) => sql(db, text).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

for (const db of ["twin_node", "twin_rust", "twin_base"]) docker("dropdb", "-U", "postgres", "--if-exists", db);
docker("createdb", "-U", "postgres", "-T", "tcgplayer_automation", "twin_base");
const [job] = sql(
  "twin_base",
  `BEGIN;
   SELECT batch_number FROM inventory_batches WHERE batch_number = ${batch} FOR UPDATE;
   INSERT INTO inventory_batch_pricing_jobs (batch_number, priority, mode, status, config_json)
     SELECT batch_number, priority, '${mode}', 'queued', config_json FROM inventory_batch_pricing_jobs
      WHERE batch_number = ${batch} ORDER BY id DESC LIMIT 1 RETURNING id;
   UPDATE inventory_batches SET status = 'queued', updated_at = NOW() WHERE batch_number = ${batch};
   COMMIT;`,
)
  .split("\n")
  .filter((line) => /^\d+$/.test(line) && Number(line) !== batch);
if (!job) throw new Error(`Batch ${batch} has no pricing job to copy the configuration of`);
docker("createdb", "-U", "postgres", "-T", "twin_base", "twin_node");
docker("createdb", "-U", "postgres", "-T", "twin_base", "twin_rust");

const env = { ...process.env, TZ: "UTC", WORKERS_RUN_IN_PROCESS: "false", HOST: "127.0.0.1", PORT: "3209" };
for (const off of ["SELLER_PORTAL_WRITES_ENABLED", "MIGRATE_ON_START", "CONTINUOUS_PRICING_SCHEDULER",
  "SELLER_ORDER_HISTORY_WORKER", "SLAB_EVIDENCE_WORKER", "INVENTORY_PUBLICATION_WORKER"]) delete env[off];

// A worker's connections are gone, so the copy's statistics include all it wrote.
async function drained(db) {
  for (let waited = 0; waited < 60; waited += 1) {
    const open = sql("postgres", `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}'`).trim();
    if (open === "0") return;
    await sleep(1000);
  }
  throw new Error(`${db}: the worker's connections did not close`);
}

const started = {};
async function runUntilDone(db, command, args, extra) {
  started[db] = sql(db, "SELECT NOW()").trim();
  const child = spawn(command, args, { env: { ...env, ...extra, DATABASE_URL: url(db) }, stdio: "ignore", shell: command === "npx" });
  try {
    for (let waited = 0; waited < 30 * 60; waited += 2) {
      await sleep(2000);
      const [status] = sql(db, `SELECT status FROM inventory_batch_pricing_jobs WHERE id = ${job}`).trim().split("\n");
      if (status === "completed" || status === "failed") return status;
    }
    throw new Error(`${db}: job ${job} did not finish in 30 minutes`);
  } finally {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
    await drained(db);
  }
}
const nodeStatus = await runUntilDone("twin_node", "npx", ["vite-node", "app/workers/pricing-worker.server.ts"], {});
const rustStatus = await runUntilDone("twin_rust", "target/debug/tcgplayer-automation", [], { PRICING_WORKER: "1" });

// Which tables each worker wrote, from each copy's own statistics.
const written = (db) => sql(db, "SELECT relname || ' ' || n_tup_ins || '/' || n_tup_upd || '/' || n_tup_del FROM pg_stat_user_tables WHERE n_tup_ins + n_tup_upd + n_tup_del > 0 ORDER BY 1").trim();
const tables = {
  inventory_batch_pricing_jobs: `SELECT to_jsonb(t) FROM inventory_batch_pricing_jobs t WHERE id = ${job}`,
  inventory_batches: `SELECT to_jsonb(t) FROM inventory_batches t WHERE batch_number = ${batch}`,
  inventory_batch_results: `SELECT to_jsonb(t) FROM inventory_batch_results t WHERE batch_number = ${batch} ORDER BY sku`,
  continuous_pricing_inventory: `SELECT to_jsonb(t) FROM continuous_pricing_inventory t WHERE last_batch_number = ${batch} ORDER BY sku`,
  inventory_strategy_pricing_curves: `SELECT to_jsonb(t) FROM inventory_strategy_pricing_curves t WHERE batch_number = ${batch} ORDER BY sku`,
  inventory_publications: `SELECT to_jsonb(t) FROM inventory_publications t WHERE pricing_job_id = ${job} ORDER BY id`,
  inventory_publication_items: `SELECT to_jsonb(i) FROM inventory_publication_items i JOIN inventory_publications p ON p.id = i.publication_id WHERE p.pricing_job_id = ${job} ORDER BY i.sku`,
};
// The listings each worker saw, kept per product and condition for the day (only which ones; the
// asks themselves move between the two reads).
const snapshots = (db) =>
  `SELECT jsonb_build_object('product', s.product_id, 'variant', s.variant, 'language', s.language, 'condition', s.condition)
     FROM product_listing_snapshots s
    WHERE s.observed_at >= '${started[db]}'
      AND s.product_id IN (SELECT k.product_id FROM inventory_batch_items i JOIN skus k ON k.sku = i.sku WHERE i.batch_number = ${batch})
    ORDER BY s.product_id, s.variant, s.language, s.condition`;
// Times differ by when each ran, and so does what is named by one: the worker's id, its
// processing time, and a publication candidate's key, which ends with when it was priced.
const timed = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(v);
const ignored = new Set(["claimed_by", "processingTime", "candidate_key"]);
const live = mode !== "cached";
const differences = [];
const moved = new Map();
let compared = 0;
function compare(at, a, b) {
  const key = at.slice(at.lastIndexOf(".") + 1);
  if (ignored.has(key) || (timed(a) && timed(b))) return;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(`${at}.${k}`, a[k], b[k]);
    return;
  }
  compared += 1;
  // A results row keeps its CSV cells as text; a number there is a number.
  const numeric = (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v);
  if (live) [a, b] = [numeric(a), numeric(b)];
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))) return;
    if (live) {
      const field = at.replace(/\[\d+\]/g, "[]");
      moved.set(field, (moved.get(field) ?? 0) + 1);
      return;
    }
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`${at}: node ${JSON.stringify(a)} rust ${JSON.stringify(b)}`);
}
const counts = [];
for (const [table, query] of Object.entries(tables)) {
  const node = rows("twin_node", query);
  const rust = rows("twin_rust", query);
  counts.push(`${table} ${node.length}/${rust.length}`);
  if (node.length !== rust.length) differences.push(`${table}: ${node.length} rows by Node, ${rust.length} by Rust`);
  node.forEach((row, i) => compare(`${table}[${i}]`, row, rust[i]));
}
const nodeSnapshots = rows("twin_node", snapshots("twin_node"));
const rustSnapshots = rows("twin_rust", snapshots("twin_rust"));
counts.push(`listing snapshots ${nodeSnapshots.length}/${rustSnapshots.length}`);
if (JSON.stringify(nodeSnapshots) !== JSON.stringify(rustSnapshots)) {
  differences.push(`listing snapshots: Node kept ${JSON.stringify(nodeSnapshots)}, Rust ${JSON.stringify(rustSnapshots)}`);
}
console.log(`Batch ${batch}, ${mode} job ${job}: Node ${nodeStatus}, Rust ${rustStatus}`);
console.log(`Written by Node:\n${written("twin_node")}\nWritten by Rust:\n${written("twin_rust")}`);
console.log(`Rows (Node/Rust): ${counts.join(", ")}`);
console.log(`${compared} values compared, ${differences.length} differ`);
for (const difference of differences.slice(0, 40)) console.log(`  ${difference}`);
if (differences.length > 40) console.log(`  and ${differences.length - 40} more`);
if (moved.size) {
  console.log("Numbers that moved with the market between the two reads, by field:");
  for (const [field, count] of [...moved].sort()) console.log(`  ${count} x ${field}`);
}
for (const db of ["twin_node", "twin_rust", "twin_base"]) docker("dropdb", "-U", "postgres", db);
process.exit(differences.length || nodeStatus !== rustStatus ? 1 : 0);
