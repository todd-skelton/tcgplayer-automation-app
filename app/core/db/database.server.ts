import pg from "pg";

const { Pool } = pg;

export type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation";

let pool: pg.Pool | null = null;
let hasLoggedDatabaseTarget = false;

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

function formatDatabaseUrlForLog(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const maskedUsername = url.username ? "***" : "";
    const maskedPassword = url.password ? ":***" : "";
    const auth = maskedUsername ? `${maskedUsername}${maskedPassword}@` : "";

    return `${url.protocol}//${auth}${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function logDatabaseTargetOnce(connectionString: string): void {
  if (hasLoggedDatabaseTarget) {
    return;
  }

  hasLoggedDatabaseTarget = true;

  try {
    const url = new URL(connectionString);
    const databaseName = url.pathname.replace(/^\/+/, "") || "(default)";
    const port = url.port || "5432";

    console.info(
      `[db] Creating PostgreSQL pool for ${formatDatabaseUrlForLog(connectionString)} ` +
        `(host=${url.hostname}, port=${port}, database=${databaseName})`,
    );
  } catch {
    console.info("[db] Creating PostgreSQL pool for the configured DATABASE_URL.");
  }
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = getDatabaseUrl();
    logDatabaseTargetOnce(connectionString);

    pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  return pool;
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  executor?: Queryable,
): Promise<T[]> {
  const client = executor ?? getPool();
  const result = await client.query<T>(text, values);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  executor?: Queryable,
): Promise<T | null> {
  const rows = await query<T>(text, values, executor);
  return rows[0] ?? null;
}

export async function execute(
  text: string,
  values: unknown[] = [],
  executor?: Queryable,
): Promise<number> {
  const client = executor ?? getPool();
  const result = await client.query(text, values);
  return result.rowCount ?? 0;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createValuesPlaceholders(
  rowCount: number,
  columnCount: number,
): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const values = Array.from({ length: columnCount }, (_, columnIndex) => {
      return `$${rowIndex * columnCount + columnIndex + 1}`;
    });

    return `(${values.join(", ")})`;
  }).join(", ");
}

export function asJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
