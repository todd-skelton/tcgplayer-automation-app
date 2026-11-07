import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateUnlessCorten } from "./docker-start-support.mjs";

// A migrator that always fails, so running it shows as a rejection.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-switch-"));
const failing = path.join(dir, "failing-migrator.mjs");
await fs.writeFile(failing, "process.exit(3);\n");
const saved = { MIGRATE_ON_START: process.env.MIGRATE_ON_START, DB_STARTUP_RETRIES: process.env.DB_STARTUP_RETRIES };
try {
  process.env.DB_STARTUP_RETRIES = "1";
  process.env.MIGRATE_ON_START = "1";
  await migrateUnlessCorten(failing);

  process.env.MIGRATE_ON_START = " ";
  await assert.rejects(migrateUnlessCorten(failing), /exited with code 3/, "a blank switch leaves the migrations to Node");
} finally {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
}
console.log("PASS Node's start script leaves the migrations to the Corten app when MIGRATE_ON_START is set");