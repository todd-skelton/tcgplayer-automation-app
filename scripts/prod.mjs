import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { loadAppEnv } from "./load-local-env.mjs";
import { unsetSwitches } from "./cortenSwitches.mjs";
import { pendingMigrationNames, planRelease } from "./releasePlan.mjs";

const composeArgs = ["compose", "-f", "docker-compose.prod.yml"];
loadAppEnv("production");
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

const allSlotsComposeArgs = [...composeArgs, "--profile", "*"];
const PUBLIC_URL = "http://localhost:3001";
const PROXY_CONTAINER = "tcgplayer-automation-proxy-prod";
const POSTGRES_CONTAINER = "tcgplayer-postgres-prod";
// A slot is the Corten app (web), which the proxy sends traffic to.
const SLOTS = {
  blue: { web: "web-blue", webContainer: "tcgplayer-automation-web-prod-blue" },
  green: { web: "web-green", webContainer: "tcgplayer-automation-web-prod-green" },
};
// What ran before release 8 (docs/prod-cutover.md) and is no longer in docker-compose.prod.yml:
// each slot's Node app, and the Node workers each earlier release removed when its switch was set.
// A release removes any still there, by name, since compose no longer knows them.
const NODE_CONTAINERS = [
  "tcgplayer-automation-prod",
  "tcgplayer-automation-prod-blue",
  "tcgplayer-automation-prod-green",
  "tcgplayer-pricing-worker-prod",
  "tcgplayer-publication-worker-prod",
  "tcgplayer-pricing-scheduler-prod",
  "tcgplayer-automation-prod-slab-evidence-worker-1",
];
const ACTIVE_SLOT_FILE = path.resolve("deploy", "nginx", "active", "active.conf");
const HEALTH_TIMEOUT_MS = 5 * 60_000;

async function listContainerNames(all = false) {
  const args = ["ps", "--format", "{{.Names}}"];

  if (all) {
    args.splice(1, 0, "-a");
  }

  const result = await run("docker", args);
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

async function readActiveSlot() {
  try {
    const conf = await fs.readFile(ACTIVE_SLOT_FILE, "utf8");
    return conf.match(/set \$app_color (blue|green);/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function writeActiveSlot(color) {
  await fs.mkdir(path.dirname(ACTIVE_SLOT_FILE), { recursive: true });
  await fs.writeFile(
    ACTIVE_SLOT_FILE,
    `set $app_upstream ${SLOTS[color].web}:3000;\nset $app_color ${color};\n`,
  );
}

/** The slot serving production now: its color, or null. */
async function findLiveSlot(running) {
  const active = await readActiveSlot();
  if (active && running.has(SLOTS[active].webContainer)) return active;
  return Object.keys(SLOTS).find((color) => running.has(SLOTS[color].webContainer)) ?? null;
}

/**
 * Release 8 removes the Node app, so it runs only once every earlier release moved its job to the
 * Corten app: otherwise a job would stop with nothing to run it.
 */
function assertNodeRetired() {
  const unset = unsetSwitches(process.env);
  if (unset.length) {
    throw new Error(
      `Production release blocked: the Node app is gone from this release, but .env.production.local does not set ${unset.join(", ")}.` +
        "\nEach is set by its own release (docs/prod-cutover.md); release those first.",
    );
  }
}

/** Removes the Node containers left from before release 8, once traffic has left them. */
async function removeNodeContainers() {
  const existing = await listContainerNames(true);
  const present = NODE_CONTAINERS.filter((name) => existing.has(name));
  if (!present.length) return;
  console.log(`Removing the Node app's containers: ${present.join(", ")}...`);
  await run("docker", ["rm", "-f", ...present], { stdio: "inherit" });
}

async function findPendingMigrations() {
  const migrationsDir = path.resolve("db", "migrations");
  const files = await fs.readdir(migrationsDir);
  const applied = await run(
    "docker",
    ["exec", POSTGRES_CONTAINER, "psql", "-U", "postgres", "-d", "tcgplayer_automation", "-tAc",
      "SELECT name FROM schema_migrations"],
    { allowFailure: true },
  );
  if (applied.code !== 0) {
    throw new Error(`Could not read applied migrations from ${POSTGRES_CONTAINER}: ${applied.stderr || applied.stdout}`);
  }
  const names = pendingMigrationNames(files, applied.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean));
  return Promise.all(
    names.map(async (name) => ({ name, sql: await fs.readFile(path.join(migrationsDir, name), "utf8") })),
  );
}

async function waitForHealthy(container) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await run(
      "docker",
      ["inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", container],
      { allowFailure: true },
    );
    const [status, health] = state.stdout.split(" ");
    if (status === "running" && health === "healthy") return;
    // A crash at startup, such as a failed migration, shows up as a restart loop.
    if (state.code !== 0 || ["exited", "dead", "restarting"].includes(status) || health === "unhealthy") {
      throw new Error(`${container} did not become healthy (${state.stdout || state.stderr}).`);
    }
    await sleep(1_000);
  }
  throw new Error(`${container} did not become healthy within ${HEALTH_TIMEOUT_MS / 60_000} minutes.`);
}

/** Starts a slot's Corten app, which applies pending migrations, and waits for its health check. */
async function startSlot(slot, { recreate }) {
  const fresh = recreate ? ["--force-recreate"] : [];
  await run("docker", [...composeArgs, "up", "-d", "--no-deps", ...fresh, slot.web], { stdio: "inherit" });
  await waitForHealthy(slot.webContainer);
}

/** Waits until requests through the public port reach the given slot. */
async function verifyTraffic(color) {
  const deadline = Date.now() + 30_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${PUBLIC_URL}/`, { signal: AbortSignal.timeout(5_000) });
      const served = response.headers.get("x-app-color");
      if (response.ok && served === color) return;
      last = `status ${response.status} from ${served ?? "no slot"}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Traffic on ${PUBLIC_URL} did not reach the ${color} slot (${last}).`);
}

/** Points the proxy at a slot. A reload lets requests already in flight finish on the old slot. */
async function routeTrafficTo(color) {
  await writeActiveSlot(color);
  if ((await listContainerNames()).has(PROXY_CONTAINER)) {
    await run("docker", ["exec", PROXY_CONTAINER, "nginx", "-t"], { stdio: "inherit" });
    await run("docker", ["exec", PROXY_CONTAINER, "nginx", "-s", "reload"], { stdio: "inherit" });
  }
  // Starts the proxy, or recreates it if its definition changed; otherwise a no-op.
  await run("docker", [...composeArgs, "up", "-d", "--no-deps", "proxy"], { stdio: "inherit" });
  await verifyTraffic(color);
}

/**
 * Builds the image, starts it in the idle slot, and moves traffic once it is
 * healthy. The running app keeps serving through the switch unless a pending
 * migration could break it (see scripts/releasePlan.mjs); then it stops first.
 */
async function release({ noCache }) {
  assertNodeRetired();
  await fs.mkdir("logs", { recursive: true });

  const live = await findLiveSlot(await listContainerNames());
  const target = live === "blue" ? "green" : "blue";
  const slot = SLOTS[target];

  // Build while the current stack keeps serving; a failed build leaves production untouched.
  console.log(`Building production image for the ${target} slot...`);
  await run("docker", [...composeArgs, "build", ...(noCache ? ["--no-cache"] : []), slot.web], { stdio: "inherit" });

  await run("docker", [...composeArgs, "up", "-d", "--wait", "postgres"], { stdio: "inherit" });
  const plan = live ? planRelease(await findPendingMigrations()) : { mode: "overlap", reasons: [] };

  if (live && plan.mode === "stop_first") {
    console.log("Stopping the running app before migrating, because the previous release may break against:");
    for (const reason of plan.reasons) console.log(`  - ${reason}`);
    await run("docker", ["stop", "-t", "30", SLOTS[live].webContainer], { stdio: "inherit" });
  } else if (live) {
    console.log(`Keeping the ${live} app serving while the ${target} slot starts.`);
  }

  console.log(`Starting the ${target} slot and applying migrations...`);
  try {
    await startSlot(slot, { recreate: true });
  } catch (error) {
    if (live && plan.mode === "overlap") {
      await run("docker", [...composeArgs, "rm", "-s", "-f", slot.web], { stdio: "inherit" });
      throw new Error(`${error.message}\nRelease stopped; the ${live} app is still serving.`, { cause: error });
    }
    throw new Error(
      `${error.message}\nProduction is down: the previous app was stopped before migrating.` +
        "\nCheck logs with: docker compose -f docker-compose.prod.yml --profile \"*\" logs",
      { cause: error },
    );
  }

  console.log(`Routing traffic to the ${target} slot...`);
  await routeTrafficTo(target);

  if (live) {
    console.log(`Stopping the ${live} slot after its in-flight requests finish...`);
    await run("docker", [...composeArgs, "rm", "-s", "-f", SLOTS[live].web], { stdio: "inherit" });
  }
  await removeNodeContainers();

  console.log("");
  console.log(`Production release successful; the ${target} slot is serving ${PUBLIC_URL}.`);
  console.log("Status: npm run prod:status");
  console.log("Logs: npm run prod:logs");
}

async function deploy() {
  await release({ noCache: true });
}

async function update() {
  console.log("Updating production with a cached build...");
  await release({ noCache: false });
}

async function start() {
  assertNodeRetired();
  console.log("Starting production...");
  const color = (await readActiveSlot()) ?? "blue";
  await run("docker", [...composeArgs, "up", "-d", "--wait", "postgres"], { stdio: "inherit" });
  await startSlot(SLOTS[color], { recreate: false });
  await writeActiveSlot(color);
  await run("docker", [...composeArgs, "up", "-d", "--no-deps", "proxy"], { stdio: "inherit" });
  console.log(`Production started at ${PUBLIC_URL} on the ${color} slot`);
}

async function stop() {
  console.log("Stopping production...");
  await run("docker", [...allSlotsComposeArgs, "down"], { stdio: "inherit" });
  console.log("Production stopped");
}

async function restart() {
  console.log("Restarting production...");
  await run("docker", [...allSlotsComposeArgs, "restart"], { stdio: "inherit" });
  console.log("Production restarted");
}

async function logs() {
  console.log("Showing production logs...");
  await run("docker", [...allSlotsComposeArgs, "logs", "-f"], { stdio: "inherit" });
}

async function status() {
  console.log(`Production status (traffic goes to the ${(await readActiveSlot()) ?? "unknown"} slot):`);
  await run("docker", [...allSlotsComposeArgs, "ps"], { stdio: "inherit" });
}

async function shell() {
  const color = await readActiveSlot();
  if (!color) throw new Error("No active production slot recorded. Run npm run prod:deploy first.");
  console.log(`Connecting to the ${color} production app container...`);
  await run("docker", ["exec", "-it", SLOTS[color].webContainer, "sh"], {
    stdio: "inherit",
  });
}

async function clean() {
  console.log("Cleaning up production containers and images...");
  await run("docker", [...allSlotsComposeArgs, "down"], { stdio: "inherit" });
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
