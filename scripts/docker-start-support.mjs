import { spawn } from "node:child_process";

const DEFAULT_RETRIES = 30;
const DEFAULT_DELAY_MS = 2000;

export function getDatabaseStartupConfig() {
  return {
    retries: Number(process.env.DB_STARTUP_RETRIES ?? DEFAULT_RETRIES),
    delayMs: Number(process.env.DB_STARTUP_DELAY_MS ?? DEFAULT_DELAY_MS),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runNodeScript(scriptPath) {
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

export async function migrateWithRetry(scriptPath, label = "Database migration") {
  const { retries, delayMs } = getDatabaseStartupConfig();

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await runNodeScript(scriptPath);
      return;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }

      console.error(`${label} attempt ${attempt} failed. Retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
}

export function spawnInheritedProcess(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`Failed to start command "${command}".`, error);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  return child;
}
