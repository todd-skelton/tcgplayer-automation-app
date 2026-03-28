import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const composeArgs = ["compose", "-f", "docker-compose.prod.yml"];
const validCommands = new Set([
  "deploy",
  "update",
  "start",
  "stop",
  "restart",
  "logs",
  "status",
  "shell",
  "clean",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        const details = result.stderr || result.stdout || `exit code ${result.code}`;
        reject(new Error(`${command} ${args.join(" ")} failed: ${details}`));
        return;
      }

      resolve(result);
    });
  });
}

async function ensureDockerReady() {
  console.log("Checking Docker setup...");

  try {
    const version = await run("docker", ["--version"]);
    if (version.stdout) {
      console.log(version.stdout);
    }
  } catch (error) {
    console.error("Docker is not installed or not in PATH.");
    console.error("Install Docker Desktop from https://www.docker.com/products/docker-desktop");
    throw error;
  }

  try {
    const info = await run("docker", ["info", "--format", "table {{.ServerVersion}}\t{{.OSType}}\t{{.Architecture}}"]);
    console.log("Docker daemon is running.");
    if (info.stdout) {
      console.log(info.stdout);
    }
  } catch (error) {
    console.error("Docker daemon is not running.");
    console.error("Start Docker Desktop and wait for it to finish booting, then try again.");
    throw error;
  }
}

async function assertProductionSource() {
  let currentBranch = "";

  console.log("Checking production source against origin/master...");

  try {
    currentBranch = (await run("git", ["branch", "--show-current"])).stdout;
  } catch {
    currentBranch = "";
  }

  try {
    await run("git", ["fetch", "origin", "master"], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      "Production deployment blocked: failed to fetch origin/master. Verify network access and that the origin remote is available, then try again.",
      { cause: error },
    );
  }

  const localHead = (await run("git", ["rev-parse", "HEAD"])).stdout;
  const remoteMaster = (await run("git", ["rev-parse", "origin/master"])).stdout;
  const repoDirty = (await run("git", ["status", "--porcelain"])).stdout;

  console.log(`Current branch: ${currentBranch || "[detached HEAD]"}`);
  console.log(`Local HEAD: ${localHead}`);
  console.log(`origin/master: ${remoteMaster}`);

  if (repoDirty) {
    throw new Error(
      [
        "Production deployment blocked: the working tree has uncommitted changes.",
        "Recovery:",
        "  git status",
        "  git stash push --include-untracked",
        "  git checkout master",
        "  git pull --ff-only origin master",
      ].join("\n"),
    );
  }

  if (localHead !== remoteMaster) {
    throw new Error(
      [
        "Production deployment blocked: local HEAD does not match origin/master.",
        "Recovery:",
        "  git fetch origin master",
        "  git checkout master",
        "  git pull --ff-only origin master",
      ].join("\n"),
    );
  }

  console.log("Production source check passed.");
}

async function listContainerNames(all = false) {
  const args = ["ps", "--format", "{{.Names}}"];

  if (all) {
    args.splice(1, 0, "-a");
  }

  const result = await run("docker", args);
  return result.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}

async function isContainerPresent(name, all = false) {
  const containerNames = await listContainerNames(all);
  return containerNames.includes(name);
}

async function deploy() {
  await fs.mkdir("logs", { recursive: true });

  if (await isContainerPresent("tcgplayer-automation-prod")) {
    console.log("Stopping existing production container...");
    await run("docker", [...composeArgs, "down"], { stdio: "inherit" });
  }

  console.log("Building production image...");
  await run("docker", [...composeArgs, "build", "--no-cache"], { stdio: "inherit" });

  console.log("Starting production container...");
  await run("docker", [...composeArgs, "up", "-d"], { stdio: "inherit" });

  console.log("Waiting for application to start...");
  await sleep(10_000);

  if (!(await isContainerPresent("tcgplayer-automation-prod"))) {
    throw new Error(
      "Production deployment failed.\nCheck logs with: docker compose -f docker-compose.prod.yml logs",
    );
  }

  console.log("Production deployment successful.");
  console.log("");
  console.log("Production app is running at: http://localhost:3001");
  console.log("Container status: docker ps --format \"{{.Names}}\"");
  console.log("View logs: docker compose -f docker-compose.prod.yml logs -f");
  console.log("Stop production: docker compose -f docker-compose.prod.yml down");
  console.log("");
  console.log("Development can still run on: http://localhost:5173 (npm run dev or npm run dev:host)");
}

async function update() {
  console.log("Updating production deployment...");
  console.log("Rebuilding production image...");
  await run("docker", [...composeArgs, "build"], { stdio: "inherit" });

  console.log("Restarting production container...");
  await run("docker", [...composeArgs, "up", "-d"], { stdio: "inherit" });

  console.log("Waiting for restart...");
  await sleep(5_000);

  if (!(await isContainerPresent("tcgplayer-automation-prod"))) {
    throw new Error(
      "Production update failed.\nCheck logs with: docker compose -f docker-compose.prod.yml logs",
    );
  }

  console.log("Production updated successfully.");
  console.log("Production app is running at: http://localhost:3001");
}

async function start() {
  console.log("Starting production...");
  await run("docker", [...composeArgs, "up", "-d"], { stdio: "inherit" });
  console.log("Production started at http://localhost:3001");
}

async function stop() {
  console.log("Stopping production...");
  await run("docker", [...composeArgs, "down"], { stdio: "inherit" });
  console.log("Production stopped");
}

async function restart() {
  console.log("Restarting production...");
  await run("docker", [...composeArgs, "restart"], { stdio: "inherit" });
  console.log("Production restarted");
}

async function logs() {
  console.log("Showing production logs...");
  await run("docker", [...composeArgs, "logs", "-f"], { stdio: "inherit" });
}

async function status() {
  console.log("Production status:");
  await run("docker", [...composeArgs, "ps"], { stdio: "inherit" });
}

async function shell() {
  console.log("Connecting to production container...");
  await run("docker", ["exec", "-it", "tcgplayer-automation-prod", "sh"], {
    stdio: "inherit",
  });
}

async function clean() {
  console.log("Cleaning up production containers and images...");
  await run("docker", [...composeArgs, "down"], { stdio: "inherit" });
  await run("docker", ["image", "prune", "-f"], { stdio: "inherit" });
  console.log("Cleanup complete");
}

function printHelp() {
  console.log("TCGPlayer Automation - Production Management");
  console.log("");
  console.log("Usage: node scripts/prod.mjs [command]");
  console.log("");
  console.log("Commands:");
  console.log("  deploy    Build and deploy the production stack");
  console.log("  update    Rebuild and refresh an existing production stack");
  console.log("  start     Start production containers");
  console.log("  stop      Stop production containers");
  console.log("  restart   Restart production containers");
  console.log("  logs      View production logs (follow mode)");
  console.log("  status    Show container status");
  console.log("  shell     Connect to the production container shell");
  console.log("  clean     Clean up containers and unused images");
  console.log("");
  console.log("Examples:");
  console.log("  npm run prod:deploy");
  console.log("  npm run prod:logs");
  console.log("  npm run prod:status");
}

async function main() {
  const command = process.argv[2];

  if (!command || !validCommands.has(command)) {
    printHelp();
    process.exit(command ? 1 : 0);
  }

  await ensureDockerReady();

  switch (command) {
    case "deploy":
      await assertProductionSource();
      await deploy();
      break;
    case "update":
      if (!(await isContainerPresent("tcgplayer-automation-prod", true))) {
        throw new Error("No existing production container found. Run npm run prod:deploy first.");
      }
      await assertProductionSource();
      await update();
      break;
    case "start":
      await assertProductionSource();
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await assertProductionSource();
      await restart();
      break;
    case "logs":
      await logs();
      break;
    case "status":
      await status();
      break;
    case "shell":
      await shell();
      break;
    case "clean":
      await clean();
      break;
    default:
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
