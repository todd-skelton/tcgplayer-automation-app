import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "./load-local-env.mjs";

const maxOldSpaceSizeOption = "--max-old-space-size=16384";
const [, , command, ...args] = process.argv;

loadLocalEnv();

function resolveCommand(commandName) {
  if (
    path.isAbsolute(commandName) ||
    commandName.includes("/") ||
    commandName.includes("\\")
  ) {
    return commandName;
  }

  const executableName =
    process.platform === "win32" ? `${commandName}.cmd` : commandName;
  const localBinary = path.resolve("node_modules", ".bin", executableName);

  if (fs.existsSync(localBinary)) {
    return localBinary;
  }

  return commandName;
}

if (!command) {
  console.error("Usage: node scripts/run-with-node-options.mjs <command> [args...]");
  process.exit(1);
}

const resolvedCommand = resolveCommand(command);
const child = spawn(resolvedCommand, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: maxOldSpaceSizeOption,
  },
  shell:
    process.platform === "win32" &&
    path.extname(resolvedCommand).toLowerCase() === ".cmd",
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
