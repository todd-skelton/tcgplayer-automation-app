import path from "node:path";
import { spawn } from "node:child_process";

import {
  migrateWithRetry,
  spawnInheritedProcess,
} from "./docker-start-support.mjs";

const DEV_DATABASE_CONTAINER_NAME = "tcgplayer-postgres-db";
const DEV_DATABASE_DESCRIPTION = "standalone development database";
const DEV_DATABASE_COMPOSE_ARGS = ["compose", "-f", "docker-compose.db.yml", "up", "-d"];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 2_000;

function formatError(command, error) {
  if (error?.code === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function run(command, args, options = {}) {
  const {
    stdio = "pipe",
    allowFailure = false,
    trim = true,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    if (stdio === "pipe") {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      reject(formatError(command, error));
    });

    child.on("exit", (code, signal) => {
      const result = {
        code: code ?? 0,
        signal,
        stdout: trim ? stdout.trim() : stdout,
        stderr: trim ? stderr.trim() : stderr,
      };

      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      if (!allowFailure && result.code !== 0) {
        const details = result.stderr || result.stdout || `${command} ${args.join(" ")} failed`;
        reject(new Error(details));
        return;
      }

      resolve(result);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDockerReady() {
  try {
    await run("docker", ["--version"]);
  } catch (error) {
    console.error("Docker is not installed or not in PATH.");
    console.error("Install Docker Desktop from https://www.docker.com/products/docker-desktop");
    throw error;
  }

  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  } catch (error) {
    console.error("Docker daemon is not running.");
    console.error("Start Docker Desktop and wait for it to finish booting, then try again.");
    throw error;
  }
}

async function getContainerDetails(name) {
  const result = await run("docker", ["inspect", name], {
    allowFailure: true,
    trim: false,
  });

  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  const [details] = JSON.parse(result.stdout);
  return details ?? null;
}

function getContainerHealthStatus(details) {
  const healthStatus = details?.State?.Health?.Status;

  if (healthStatus) {
    return healthStatus;
  }

  return details?.State?.Status ?? "missing";
}

async function waitForHealthyContainer(name, options = {}) {
  const {
    description = name,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";

  while (Date.now() < deadline) {
    const details = await getContainerDetails(name);
    lastStatus = getContainerHealthStatus(details);

    if (details?.State?.Status === "running" && (!details.State.Health || lastStatus === "healthy")) {
      return;
    }

    await sleep(pollMs);
  }

  throw new Error(`${description} did not become healthy in time. Last status: ${lastStatus}`);
}

async function ensureDevelopmentDatabase() {
  console.log("Starting standalone development database container...");
  await run("docker", DEV_DATABASE_COMPOSE_ARGS, { stdio: "inherit" });

  console.log("Waiting for standalone development database to become healthy...");
  await waitForHealthyContainer(DEV_DATABASE_CONTAINER_NAME, {
    description: DEV_DATABASE_DESCRIPTION,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const prepareOnly = args.includes("--prepare-only");
  const devServerArgs = args.filter((value) => value !== "--prepare-only");

  await ensureDockerReady();
  await ensureDevelopmentDatabase();
  await migrateWithRetry(path.resolve("scripts/db-migrate.mjs"));

  if (prepareOnly) {
    console.log("Development database is ready.");
    return;
  }

  spawnInheritedProcess(process.execPath, [
    path.resolve("scripts/run-with-node-options.mjs"),
    "react-router",
    "dev",
    ...devServerArgs,
  ]);
}

main().catch((error) => {
  console.error("Host development startup failed.", error);
  process.exit(1);
});
