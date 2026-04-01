import path from "node:path";

import {
  migrateWithRetry,
  spawnInheritedProcess,
} from "./docker-start-support.mjs";

async function main() {
  await migrateWithRetry(path.resolve("scripts/db-migrate.mjs"));

  spawnInheritedProcess(process.execPath, [
    path.resolve("scripts/run-with-node-options.mjs"),
    "react-router",
    "dev",
    "--host",
    "0.0.0.0",
  ]);
}

main().catch((error) => {
  console.error("Dev container startup failed.", error);
  process.exit(1);
});
