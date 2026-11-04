// Makes a throwaway database with the dev database's schema and no rows (slab_parity), records
// Node's slab maintenance cycles in it (scripts/parity/slab-cycle.ts), then drops it.
//
//   node scripts/parity/slab-cycle.mjs
import { execFileSync } from "node:child_process";

const CONTAINER = "tcgplayer-postgres-db";
const docker = (args, input) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, ...args], { input, maxBuffer: 1e9 }).toString();
docker(["dropdb", "-U", "postgres", "--if-exists", "slab_parity"]);
docker(["createdb", "-U", "postgres", "slab_parity"]);
try {
  const schema = docker(["pg_dump", "-U", "postgres", "--schema-only", "--no-owner", "tcgplayer_automation"]);
  docker(["psql", "-U", "postgres", "-d", "slab_parity", "-q", "-v", "ON_ERROR_STOP=1"], schema);
  execFileSync("npx", ["vite-node", "scripts/parity/slab-cycle.ts"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, TZ: "UTC", WORKERS_RUN_IN_PROCESS: "false", DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/slab_parity" },
  });
} finally {
  docker(["dropdb", "-U", "postgres", "slab_parity"]);
}
