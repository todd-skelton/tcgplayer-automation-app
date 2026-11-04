// Two copies of the dev database, one for Node's worker and one for the Rust worker, and the
// comparison of what each wrote. Used by the twin-*.mjs scripts; see twin-pricing-worker.mjs.
//
// Needs the dev database container (tcgplayer-postgres-db) with no other sessions on the dev
// database while it is copied, and a fresh `cargo build`. Neither worker publishes: Seller Portal
// writes stay off and only the worker under test is started.
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CONTAINER = "tcgplayer-postgres-db";
export const BASE = "twin_base";
export const NODE = "twin_node";
export const RUST = "twin_rust";
const url = (db) => `postgresql://postgres:postgres@localhost:5433/${db}`;
const docker = (...args) => execFileSync("docker", ["exec", CONTAINER, ...args], { maxBuffer: 1e9 }).toString();
export const sql = (db, text) => docker("psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", text);
export const rows = (db, text) => sql(db, text).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

export function drop() {
  for (const db of [NODE, RUST, BASE]) docker("dropdb", "-U", "postgres", "--if-exists", db);
}

/// Copies the dev database to the base, lets `prepare` change it, then copies the base for each worker.
export function copy(prepare = () => {}) {
  drop();
  docker("createdb", "-U", "postgres", "-T", "tcgplayer_automation", BASE);
  const prepared = prepare(BASE);
  docker("createdb", "-U", "postgres", "-T", BASE, NODE);
  docker("createdb", "-U", "postgres", "-T", BASE, RUST);
  return prepared;
}

const env = { ...process.env, TZ: "UTC", WORKERS_RUN_IN_PROCESS: "false", HOST: "127.0.0.1", PORT: "3209" };
for (const off of ["SELLER_PORTAL_WRITES_ENABLED", "MIGRATE_ON_START", "PRICING_WORKER", "PUBLICATION_WORKER",
  "CONTINUOUS_PRICING_SCHEDULER", "SELLER_ORDER_HISTORY_WORKER", "SLAB_EVIDENCE_WORKER", "INVENTORY_PUBLICATION_WORKER"]) delete env[off];

// A worker's connections are gone, so the copy's statistics include all it wrote.
async function drained(db) {
  for (let waited = 0; waited < 60; waited += 1) {
    const open = sql("postgres", `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}'`).trim();
    if (open === "0") return;
    await sleep(1000);
  }
  throw new Error(`${db}: the worker's connections did not close`);
}

/// When each copy's worker started, by the database's clock.
export const started = {};

/// Runs a worker on a copy until `done(db)` answers something other than undefined, polled every
/// two seconds, for at most `minutes`; then stops it and waits for its connections to close.
export async function runUntil(db, command, args, extra, done, minutes = 30) {
  started[db] = sql(db, "SELECT NOW()").trim();
  const child = spawn(command, args, { env: { ...env, ...extra, DATABASE_URL: url(db) }, stdio: "ignore", shell: command === "npx" });
  try {
    for (let waited = 0; waited < minutes * 60; waited += 2) {
      await sleep(2000);
      const answer = await done(db);
      if (answer !== undefined) return answer;
    }
    throw new Error(`${db}: the worker was not done in ${minutes} minutes`);
  } finally {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
    await drained(db);
  }
}

export const node = (script) => ["npx", ["vite-node", `app/workers/${script}`]];
export const rust = ["target/debug/tcgplayer-automation", []];

/// Which tables a worker wrote, from its copy's own statistics.
export const written = (db) =>
  sql(db, "SELECT relname || ' ' || n_tup_ins || '/' || n_tup_upd || '/' || n_tup_del FROM pg_stat_user_tables WHERE n_tup_ins + n_tup_upd + n_tup_del > 0 ORDER BY 1").trim();

const timed = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(v);

/// Compares rows field by field. Times differ by when each worker ran and are skipped, as are the
/// `ignored` fields. With `live`, the workers read TCGplayer minutes apart: a number (or numeric
/// text) that differs is counted as moved with the market rather than as a difference.
export function comparison({ ignored = [], live = false }) {
  const skip = new Set(ignored);
  const differences = [];
  const moved = new Map();
  const counts = [];
  let compared = 0;
  const numeric = (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v);
  function compare(at, a, b) {
    const key = at.slice(at.lastIndexOf(".") + 1);
    if (skip.has(key) || (timed(a) && timed(b))) return;
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(`${at}.${k}`, a[k], b[k]);
      return;
    }
    compared += 1;
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
  return {
    differences,
    /// Each query's rows on both copies, compared in order.
    tables(queries) {
      for (const [table, query] of Object.entries(queries)) {
        const [n, r] = [rows(NODE, typeof query === "function" ? query(NODE) : query), rows(RUST, typeof query === "function" ? query(RUST) : query)];
        counts.push(`${table} ${n.length}/${r.length}`);
        if (n.length !== r.length) differences.push(`${table}: ${n.length} rows by Node, ${r.length} by Rust`);
        n.forEach((row, i) => compare(`${table}[${i}]`, row, r[i]));
      }
    },
    /// Every row of every table either worker wrote, in primary key order, or by the query `instead`
    /// gives for a table (one whose ids are assigned in an order that does not matter).
    writtenTables(instead = {}) {
      const names = new Set(
        [NODE, RUST].flatMap((db) =>
          sql(db, "SELECT relname FROM pg_stat_user_tables WHERE n_tup_ins + n_tup_upd + n_tup_del > 0").trim().split("\n").filter(Boolean),
        ),
      );
      const queries = {};
      for (const table of [...names].sort()) {
        if (instead[table]) {
          queries[table] = instead[table];
          continue;
        }
        const key = sql(
          NODE,
          `SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY array_position(i.indkey::int2[], a.attnum))
             FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = '${table}'::regclass AND i.indisprimary`,
        ).trim();
        queries[table] = `SELECT to_jsonb(t) FROM ${table} t ORDER BY ${key || "to_jsonb(t)::text"}`;
      }
      this.tables(queries);
    },
    /// Both copies' rows must be the same, whole.
    same(name, query) {
      const [n, r] = [rows(NODE, query(NODE)), rows(RUST, query(RUST))];
      counts.push(`${name} ${n.length}/${r.length}`);
      if (JSON.stringify(n) !== JSON.stringify(r)) differences.push(`${name}: Node ${JSON.stringify(n)}, Rust ${JSON.stringify(r)}`);
    },
    report() {
      console.log(`Written by Node:\n${written(NODE)}\nWritten by Rust:\n${written(RUST)}`);
      console.log(`Rows (Node/Rust): ${counts.join(", ")}`);
      console.log(`${compared} values compared, ${differences.length} differ`);
      for (const difference of differences.slice(0, 40)) console.log(`  ${difference}`);
      if (differences.length > 40) console.log(`  and ${differences.length - 40} more`);
      if (moved.size) {
        console.log("Numbers that moved with the market between the two reads, by field:");
        for (const [field, count] of [...moved].sort()) console.log(`  ${count} x ${field}`);
      }
      return differences.length;
    },
  };
}
