import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { getDatabaseUrl } from "./database.server";

const migration = readFileSync(
  new URL("../../../db/migrations/035_add_inventory_receipt_history.sql", import.meta.url),
  "utf8",
);
const schema = `receipt_migration_${Date.now()}`;
const client = new pg.Client({ connectionString: getDatabaseUrl() });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET LOCAL search_path TO ${schema}`);
  await client.query(`CREATE TABLE pending_inventory (
    sku INTEGER PRIMARY KEY,
    quantity INTEGER NOT NULL,
    product_line_id INTEGER NOT NULL,
    set_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`);
  await client.query(`CREATE TABLE inventory_batches (
    batch_number INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY
  )`);
  const originalCreatedAt = new Date("2025-01-02T03:04:05.000Z");
  const originalUpdatedAt = new Date("2025-02-03T04:05:06.000Z");
  await client.query(
    `INSERT INTO pending_inventory
      (sku, quantity, product_line_id, set_id, product_id, created_at, updated_at)
    VALUES (7001, 12, 4, 5, 6, $1, $2)`,
    [originalCreatedAt, originalUpdatedAt],
  );

  await client.query(migration);

  const pending = await client.query(`SELECT * FROM pending_inventory WHERE sku = 7001`);
  assert.equal(pending.rows[0]?.quantity, 12);
  assert.equal(pending.rows[0]?.created_at.toISOString(), originalCreatedAt.toISOString());
  assert.equal(pending.rows[0]?.updated_at.toISOString(), originalUpdatedAt.toISOString());

  const receipt = await client.query(`SELECT * FROM inventory_receipts WHERE sku = 7001`);
  assert.equal(receipt.rows[0]?.original_quantity, 12);
  assert.equal(receipt.rows[0]?.intake_at, null);
  assert.equal(receipt.rows[0]?.market_value, null);
  assert.equal(receipt.rows[0]?.market_observed_at, null);
  assert.equal(receipt.rows[0]?.market_calculated_at, null);
  assert.equal(
    new Date(receipt.rows[0]?.source_evidence.legacyPendingCreatedAt).toISOString(),
    originalCreatedAt.toISOString(),
  );
  assert.equal(
    new Date(receipt.rows[0]?.source_evidence.legacyPendingUpdatedAt).toISOString(),
    originalUpdatedAt.toISOString(),
  );

  console.log("PASS legacy pending inventory migrates with unknown intake evidence");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
