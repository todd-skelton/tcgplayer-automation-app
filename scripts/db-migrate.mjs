import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-local-env.mjs";

const { Client } = pg;
const migrationsDir = path.resolve(process.cwd(), "db", "migrations");
loadLocalEnv();
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation";

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function run() {
  const client = new Client({
    connectionString: databaseUrl,
  });

  await client.connect();

  try {
    await ensureMigrationsTable(client);

    const migrationFiles = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const fileName of migrationFiles) {
      const applied = await client.query(
        `SELECT 1 FROM schema_migrations WHERE name = $1`,
        [fileName],
      );

      if (applied.rowCount) {
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, fileName), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (name) VALUES ($1)`,
          [fileName],
        );
        await client.query("COMMIT");
        console.log(`Applied migration ${fileName}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
});
