// Runs scripts/parity/publish-selections.ts once per case in tests/fixtures/node/publication/
// publish-cases.json, each on a fresh copy of the dev database (publish_parity), dropped after.
//
//   node scripts/parity/publish-selections.mjs
//
// Needs no other sessions on the dev database while it is copied.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const CONTAINER = "tcgplayer-postgres-db";
const docker = (...args) => execFileSync("docker", ["exec", CONTAINER, ...args]).toString();
const OUT = "tests/fixtures/node/publication";
const cases = JSON.parse(readFileSync(`${OUT}/publish-cases.json`, "utf8"));
// Each case is planned an hour after its batch was last priced, so its candidates are fresh; a
// `late` case, three days after, when they are past the policy's day. A missing batch is planned now.
const at = (c) =>
  docker("psql", "-U", "postgres", "-d", "tcgplayer_automation", "-At", "-c",
    `SELECT to_char(coalesce(max(completed_at), now()) AT TIME ZONE 'UTC' + interval '${c.late ? "3 days" : "1 hour"}',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       FROM inventory_batch_pricing_jobs WHERE status = 'completed' AND batch_number = ${c.batch}`).trim();
rmSync(`${OUT}/publish.json`, { force: true });
for (const [index, c] of cases.entries()) {
  docker("dropdb", "-U", "postgres", "--if-exists", "publish_parity");
  docker("createdb", "-U", "postgres", "-T", "tcgplayer_automation", "publish_parity");
  try {
    execFileSync("npx", ["vite-node", "scripts/parity/publish-selections.ts", String(index), at(c)], {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        TZ: "UTC",
        WORKERS_RUN_IN_PROCESS: "false",
        SELLER_PORTAL_WRITES_ENABLED: "",
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/publish_parity",
      },
    });
  } finally {
    docker("dropdb", "-U", "postgres", "publish_parity");
  }
}
