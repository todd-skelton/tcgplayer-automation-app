import path from "node:path";
import dotenv from "dotenv";

const ENV_FILE_NAMES = [".env.local", ".env"];

let loaded = false;

export function loadLocalEnv() {
  if (loaded) {
    return;
  }

  loaded = true;

  for (const fileName of ENV_FILE_NAMES) {
    dotenv.config({
      path: path.resolve(process.cwd(), fileName),
      override: false,
      quiet: true,
    });
  }
}
