import path from "node:path";

import {
  migrateWithRetry,
  spawnInheritedProcesses,
} from "./docker-start-support.mjs";

async function main() {
  await migrateWithRetry(path.resolve("scripts/db-migrate.mjs"));

  spawnInheritedProcesses([
    {
      command: process.execPath,
      args: [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("app/workers/seller-order-history-worker.server.ts")],
    },
    {
      command: process.execPath,
      args: [path.resolve("scripts/run-with-node-options.mjs"), "react-router", "dev", "--host", "0.0.0.0"],
    },
  ]);
}

main().catch((error) => {
  console.error("Dev container startup failed.", error);
  process.exit(1);
});
