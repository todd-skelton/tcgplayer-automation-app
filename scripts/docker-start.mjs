import path from "node:path";

import {
  migrateWithRetry,
  spawnInheritedProcess,
} from "./docker-start-support.mjs";

async function main() {
  await migrateWithRetry(path.resolve("scripts/db-migrate.mjs"));

  const serverBinary =
    process.platform === "win32"
      ? path.resolve("node_modules/.bin/react-router-serve.cmd")
      : path.resolve("node_modules/.bin/react-router-serve");

  spawnInheritedProcess(serverBinary, ["./build/server/index.js"]);
}

main().catch((error) => {
  console.error("Container startup failed.", error);
  process.exit(1);
});
