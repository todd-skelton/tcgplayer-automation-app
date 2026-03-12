import { spawn } from "node:child_process";
import path from "node:path";

const retries = Number(process.env.DB_STARTUP_RETRIES ?? 30);
const delayMs = Number(process.env.DB_STARTUP_DELAY_MS ?? 2000);
const shouldImport = process.env.DB_IMPORT_ON_START === "true";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${scriptPath} exited with code ${code ?? 1}`));
    });
  });
}

async function migrateWithRetry() {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await runNodeScript(path.resolve("scripts/db-migrate.mjs"));
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }

      console.error(
        `Database migration attempt ${attempt} failed. Retrying in ${delayMs}ms.`,
      );
      await sleep(delayMs);
    }
  }
}

async function main() {
  await migrateWithRetry();

  if (shouldImport) {
    await runNodeScript(path.resolve("scripts/db-import.mjs"));
  }

  const serverBinary =
    process.platform === "win32"
      ? path.resolve("node_modules/.bin/react-router-serve.cmd")
      : path.resolve("node_modules/.bin/react-router-serve");

  const server = spawn(serverBinary, ["./build/server/index.js"], {
    stdio: "inherit",
    env: process.env,
  });

  server.on("error", (error) => {
    console.error("Failed to start the app server.", error);
    process.exit(1);
  });

  server.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error("Container startup failed.", error);
  process.exit(1);
});
