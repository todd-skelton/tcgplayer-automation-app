import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

const DATABASE_NAME = "tcgplayer_automation";
const DATABASE_USER = "postgres";
const DATABASE_PASSWORD = "postgres";
const BACKUP_DIR = path.resolve(".artifacts", "db-backups");
const DB_HOST_URL = `postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@localhost:5433/${DATABASE_NAME}`;
const prodDatabase = {
  containerName: "tcgplayer-postgres-prod",
  label: "production",
};

const targets = {
  dev: {
    key: "dev",
    label: "full Docker dev stack",
    dbContainerName: "tcgplayer-postgres-dev",
    appContainerName: "tcgplayer-automation-dev",
    ensureArgs: ["compose", "-f", "docker-compose.yml", "up", "-d", "postgres"],
    startArgs: ["compose", "-f", "docker-compose.yml", "up", "-d", "app"],
  },
  db: {
    key: "db",
    label: "standalone development database",
    dbContainerName: "tcgplayer-postgres-db",
    ensureArgs: ["compose", "-f", "docker-compose.db.yml", "up", "-d"],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(command, error) {
  if (error?.code === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function getFailureDetails(command, args, code, stdout, stderr) {
  return stderr || stdout || `${command} ${args.join(" ")} failed with exit code ${code}`;
}

function run(command, args, options = {}) {
  const {
    stdio = "pipe",
    allowFailure = false,
    trim = true,
    env = process.env,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio,
      env,
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
        reject(new Error(getFailureDetails(command, args, result.code, result.stdout, result.stderr)));
        return;
      }

      resolve(result);
    });
  });
}

function writeCommandOutputToFile(command, args, outputPath, options = {}) {
  const { env = process.env } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    const outputStream = fs.createWriteStream(outputPath, { flags: "wx" });
    let stderr = "";
    let settled = false;

    const finishWithError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      outputStream.destroy();
      fsPromises.unlink(outputPath).catch(() => {}).finally(() => {
        reject(error);
      });
    };

    child.stdout.pipe(outputStream);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    outputStream.on("error", (error) => {
      finishWithError(error);
    });

    child.on("error", (error) => {
      finishWithError(formatError(command, error));
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      if (signal) {
        finishWithError(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      if ((code ?? 0) !== 0) {
        finishWithError(new Error(getFailureDetails(command, args, code ?? 1, "", stderr.trim())));
        return;
      }

      outputStream.end(() => {
        settled = true;
        resolve();
      });
    });
  });
}

function pipeFileToCommand(inputPath, command, args, options = {}) {
  const { env = process.env } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "inherit", "pipe"],
      env,
    });

    const inputStream = fs.createReadStream(inputPath);
    let stderr = "";
    let settled = false;

    const finishWithError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      inputStream.destroy();
      child.stdin.destroy();
      reject(error);
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    inputStream.on("error", (error) => {
      finishWithError(error);
    });

    child.on("error", (error) => {
      finishWithError(formatError(command, error));
    });

    inputStream.pipe(child.stdin);

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      if (signal) {
        finishWithError(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      if ((code ?? 0) !== 0) {
        finishWithError(new Error(getFailureDetails(command, args, code ?? 1, "", stderr.trim())));
        return;
      }

      settled = true;
      resolve();
    });
  });
}

function runNodeScript(scriptPath, options = {}) {
  const { env = process.env } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env,
    });

    child.on("error", (error) => {
      reject(formatError(process.execPath, error));
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${scriptPath} exited with signal ${signal}`));
        return;
      }

      if ((code ?? 0) !== 0) {
        reject(new Error(`${scriptPath} exited with code ${code ?? 1}`));
        return;
      }

      resolve();
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

async function getContainerDetails(name) {
  const result = await run("docker", ["inspect", name], { allowFailure: true, trim: false });

  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }

  const [details] = JSON.parse(result.stdout);
  return details ?? null;
}

async function listRunningContainerNames() {
  const result = await run("docker", ["ps", "--format", "{{.Names}}"]);
  return result.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
}

async function isContainerRunning(name) {
  const containerNames = await listRunningContainerNames();
  return containerNames.includes(name);
}

function getContainerHealthStatus(details) {
  const health = details?.State?.Health?.Status;
  if (health) {
    return health;
  }

  return details?.State?.Status ?? "missing";
}

async function waitForHealthyContainer(name, options = {}) {
  const { timeoutMs = 120_000, pollMs = 2_000, description = name } = options;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";

  while (Date.now() < deadline) {
    const details = await getContainerDetails(name);
    lastStatus = getContainerHealthStatus(details);

    if (details?.State?.Status === "running" && (!details.State.Health || lastStatus === "healthy")) {
      return details;
    }

    await sleep(pollMs);
  }

  throw new Error(`${description} did not become healthy in time. Last status: ${lastStatus}`);
}

async function assertHealthyContainer(name, description) {
  const details = await getContainerDetails(name);

  if (!details) {
    throw new Error(`${description} container "${name}" was not found.`);
  }

  if (details.State?.Status !== "running") {
    throw new Error(`${description} container "${name}" is not running.`);
  }

  const healthStatus = getContainerHealthStatus(details);
  if (details.State?.Health && healthStatus !== "healthy") {
    throw new Error(`${description} container "${name}" is not healthy. Current status: ${healthStatus}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    target: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }

    if (value === "--target") {
      const nextValue = argv[index + 1];
      if (!nextValue || nextValue.startsWith("--")) {
        throw new Error("Missing value for --target. Use --target=dev or --target=db.");
      }

      parsed.target = nextValue;
      index += 1;
      continue;
    }

    if (value.startsWith("--target=")) {
      parsed.target = value.slice("--target=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  if (parsed.target && !targets[parsed.target]) {
    throw new Error(`Unsupported target "${parsed.target}". Use --target=dev or --target=db.`);
  }

  return parsed;
}

function printHelp() {
  console.log("TCGPlayer Automation - Refresh Dev DB From Production");
  console.log("");
  console.log("Usage:");
  console.log("  npm run dev:db:refresh");
  console.log("  npm run dev:db:refresh -- --target=dev");
  console.log("  npm run dev:db:refresh -- --target=db");
  console.log("");
  console.log("Targets:");
  console.log("  dev   Refresh the full Docker dev stack database (tcgplayer-postgres-dev)");
  console.log("  db    Refresh the standalone dev database used by docker-compose.db.yml");
  console.log("");
  console.log("Default behavior:");
  console.log("  - If exactly one dev database is running, refresh that target.");
  console.log("  - If neither is running, start the standalone dev database and refresh it.");
  console.log("  - If both are running, require --target because they use separate volumes.");
}

async function resolveTarget(explicitTargetKey) {
  if (explicitTargetKey) {
    return targets[explicitTargetKey];
  }

  const runningContainers = await listRunningContainerNames();
  const devRunning = runningContainers.includes(targets.dev.dbContainerName);
  const dbRunning = runningContainers.includes(targets.db.dbContainerName);

  if (devRunning && dbRunning) {
    throw new Error(
      [
        "Both development database targets are running.",
        "They use separate Docker volumes, so the refresh target is ambiguous.",
        "Run the command again with --target=dev or --target=db.",
      ].join("\n"),
    );
  }

  if (devRunning) {
    return targets.dev;
  }

  if (dbRunning) {
    return targets.db;
  }

  console.log("No development database container is running. Starting the standalone development database...");
  await run("docker", targets.db.ensureArgs, { stdio: "inherit" });
  return targets.db;
}

async function ensureTargetReady(target) {
  const targetIsRunning = await isContainerRunning(target.dbContainerName);

  if (!targetIsRunning) {
    console.log(`Starting ${target.label} database container...`);
    await run("docker", target.ensureArgs, { stdio: "inherit" });
  }

  await waitForHealthyContainer(target.dbContainerName, {
    description: `${target.label} database`,
  });
}

async function dumpDatabaseToFile(containerName, outputPath) {
  await writeCommandOutputToFile(
    "docker",
    ["exec", containerName, "pg_dump", "-U", DATABASE_USER, "-d", DATABASE_NAME, "-Fc"],
    outputPath,
  );
}

async function recreateDatabase(containerName) {
  await run(
    "docker",
    [
      "exec",
      containerName,
      "psql",
      "-U",
      DATABASE_USER,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`,
    ],
    { stdio: "inherit" },
  );

  await run(
    "docker",
    [
      "exec",
      containerName,
      "psql",
      "-U",
      DATABASE_USER,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `CREATE DATABASE "${DATABASE_NAME}"`,
    ],
    { stdio: "inherit" },
  );
}

async function restoreDatabaseFromFile(containerName, dumpPath) {
  await pipeFileToCommand(
    dumpPath,
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "pg_restore",
      "--no-owner",
      "--no-privileges",
      "-U",
      DATABASE_USER,
      "-d",
      DATABASE_NAME,
    ],
  );
}

async function restartDevApp(target) {
  if (!target.startArgs) {
    return;
  }

  await run("docker", target.startArgs, { stdio: "inherit" });
}

async function main() {
  const { help, target: explicitTargetKey } = parseArgs(process.argv.slice(2));

  if (help) {
    printHelp();
    return;
  }

  await ensureDockerReady();
  await assertHealthyContainer(prodDatabase.containerName, "Production database");

  const target = await resolveTarget(explicitTargetKey);
  await ensureTargetReady(target);

  console.log(`Source container: ${prodDatabase.containerName}`);
  console.log(`Target container: ${target.dbContainerName}`);
  console.log(`Target mode: ${target.label}`);

  await fsPromises.mkdir(BACKUP_DIR, { recursive: true });

  const timestamp = formatTimestamp();
  const currentDevBackupPath = path.join(BACKUP_DIR, `${timestamp}-${target.key}-before-refresh.dump`);
  const prodDumpPath = path.join(BACKUP_DIR, `${timestamp}-prod-refresh-source.dump`);

  let appWasRunning = false;
  let destructiveStepStarted = false;
  let prodDumpCreated = false;
  let refreshSucceeded = false;

  try {
    if (target.appContainerName) {
      appWasRunning = await isContainerRunning(target.appContainerName);

      if (appWasRunning) {
        console.log(`Stopping ${target.appContainerName} so it does not reconnect during the refresh...`);
        await run("docker", ["stop", target.appContainerName], { stdio: "inherit" });
      } else {
        console.log(`${target.appContainerName} is not running. The refresh will still target its database volume.`);
      }
    }

    console.log(`Backing up current target database to ${currentDevBackupPath}...`);
    await dumpDatabaseToFile(target.dbContainerName, currentDevBackupPath);

    console.log(`Exporting production database to ${prodDumpPath}...`);
    await dumpDatabaseToFile(prodDatabase.containerName, prodDumpPath);
    prodDumpCreated = true;

    console.log(`Recreating ${DATABASE_NAME} in ${target.dbContainerName}...`);
    destructiveStepStarted = true;
    await recreateDatabase(target.dbContainerName);

    console.log("Restoring production dump into the target database...");
    await restoreDatabaseFromFile(target.dbContainerName, prodDumpPath);

    if (target.key === "dev") {
      console.log("Starting the development app container again...");
      await restartDevApp(target);
      console.log("The development app will run its normal startup migrations as it comes back up.");
    } else {
      console.log("Running migrations for the standalone development database...");
      await runNodeScript(path.resolve("scripts/db-migrate.mjs"), {
        env: {
          ...process.env,
          DATABASE_URL: DB_HOST_URL,
        },
      });
      console.log("Standalone development database is ready on localhost:5433.");
    }

    refreshSucceeded = true;
  } catch (error) {
    console.error("");
    console.error("Development database refresh failed.");
    console.error(`Current dev backup preserved at: ${currentDevBackupPath}`);

    if (prodDumpCreated) {
      console.error(`Production dump preserved at: ${prodDumpPath}`);
    }

    if (target.key === "dev") {
      if (appWasRunning && !destructiveStepStarted) {
        try {
          console.error("Restarting the dev app because the refresh failed before the database was replaced...");
          await restartDevApp(target);
        } catch (restartError) {
          console.error(
            "Automatic dev app restart also failed:",
            restartError instanceof Error ? restartError.message : restartError,
          );
        }
      } else {
        console.error("The full dev app container may still be stopped. After recovery, restart it with:");
        console.error("  docker compose -f docker-compose.yml up -d app");
      }
    }

    console.error("Use the preserved backup dump if you need to restore the previous dev database state.");
    throw error;
  } finally {
    if (refreshSucceeded) {
      await fsPromises.unlink(prodDumpPath).catch(() => {});
    }
  }

  console.log("");
  console.log("Development database refresh completed successfully.");
  console.log(`Source container: ${prodDatabase.containerName}`);
  console.log(`Target container: ${target.dbContainerName}`);
  console.log(`Backup file: ${currentDevBackupPath}`);
  console.log("Recovery guidance: keep the backup dump until you have confirmed the refreshed dev environment is healthy.");
}

main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
