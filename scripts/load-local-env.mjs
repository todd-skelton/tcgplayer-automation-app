import path from "node:path";
import dotenv from "dotenv";

const loadedModes = new Set();

function getEnvFileNames(mode) {
  switch (mode) {
    case "development":
      return [
        ".env.development.local",
        ".env.local",
        ".env.development",
        ".env",
      ];
    case "production":
      return [
        ".env.production.local",
        ".env.production",
        ".env",
      ];
    default:
      return [".env.local", ".env"];
  }
}

export function loadAppEnv(mode) {
  const normalizedMode = mode ?? "default";

  if (loadedModes.has(normalizedMode)) {
    return;
  }

  loadedModes.add(normalizedMode);

  for (const fileName of getEnvFileNames(mode)) {
    dotenv.config({
      path: path.resolve(process.cwd(), fileName),
      override: false,
      quiet: true,
    });
  }
}

export function loadLocalEnv() {
  loadAppEnv();
}
