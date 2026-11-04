// Runs scripts/parity/pubworker.ts once per case in tests/fixtures/node/publication/pubworker-cases.json,
// each on a fresh copy of the dev database (pubworker_parity), dropped after.
//
//   node scripts/parity/pubworker.mjs
//
// Needs no other sessions on the dev database while it is copied.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const CONTAINER = "tcgplayer-postgres-db";
const DB = "pubworker_parity";
const docker = (...args) => execFileSync("docker", ["exec", CONTAINER, ...args]).toString();
const OUT = "tests/fixtures/node/publication";
const cases = JSON.parse(readFileSync(`${OUT}/pubworker-cases.json`, "utf8"));
rmSync(`${OUT}/pubworker.node.json`, { force: true });
const env = { ...process.env, TZ: "UTC", WORKERS_RUN_IN_PROCESS: "false", DATABASE_URL: `postgresql://postgres:postgres@localhost:5433/${DB}` };
delete env.SELLER_PORTAL_WRITES_ENABLED;
for (const index of cases.keys()) {
  docker("dropdb", "-U", "postgres", "--if-exists", DB);
  docker("createdb", "-U", "postgres", "-T", "tcgplayer_automation", DB);
  try {
    execFileSync("npx", ["vite-node", "scripts/parity/pubworker.ts", String(index)], { stdio: "inherit", shell: true, env });
  } finally {
    docker("dropdb", "-U", "postgres", DB);
  }
}
