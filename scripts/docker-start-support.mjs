import { spawn } from "node:child_process";

const DEFAULT_RETRIES = 30;
const DEFAULT_DELAY_MS = 2000;
// Stays under the production stop_grace_period so Docker never has to kill a draining server.
const CHILD_EXIT_TIMEOUT_MS = 25_000;

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

/** Runs sibling long-lived processes as one service and never leaves an orphan. */
export function spawnInheritedProcesses(processes) {
  const children = [];
  const running = new Set();
  let stopping = false;
  let exitCode = 0;

  const exitWhenChildrenStop = () => {
    if (stopping && running.size === 0) process.exit(exitCode);
  };

  // Waits for every child to finish (a web server finishes in-flight requests first).
  const stop = (signal = "SIGTERM", code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) {
      if (running.has(child)) child.kill(signal);
    }
    setTimeout(() => process.exit(exitCode), CHILD_EXIT_TIMEOUT_MS).unref();
    exitWhenChildrenStop();
  };

  for (const processSpec of processes) {
    let child;
    try {
      child = spawn(processSpec.command, processSpec.args, {
        stdio: "inherit",
        env: process.env,
      });
    } catch (error) {
      console.error(`Failed to start command "${processSpec.command}".`, error);
      stop("SIGTERM", 1);
      return children;
    }
    children.push(child);
    running.add(child);
    child.on("error", (error) => {
      console.error(`Failed to start command "${processSpec.command}".`, error);
      stop("SIGTERM", 1);
    });
    child.on("exit", (code, signal) => {
      running.delete(child);
      if (!stopping) stop(signal ?? "SIGTERM", code ?? 1);
      exitWhenChildrenStop();
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => stop(signal, 0));
  }
  return children;
}
