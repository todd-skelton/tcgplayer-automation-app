import path from "node:path";

import {
  migrateWithRetry,
  spawnInheritedProcesses,
} from "./docker-start-support.mjs";

async function main() {
  await migrateWithRetry(path.resolve("scripts/db-migrate.mjs"));

  spawnInheritedProcesses([
    { command: process.execPath, args: [path.resolve("build/workers/seller-order-history-worker.js")] },
    {
      command: process.execPath,
      args: [path.resolve("node_modules/@react-router/serve/bin.js"), "./build/server/index.js"],
    },
  ]);
}

main().catch((error) => {
  console.error("Container startup failed.", error);
  process.exit(1);
});
