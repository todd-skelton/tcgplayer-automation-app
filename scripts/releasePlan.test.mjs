import assert from "node:assert/strict";
import { migrationRisks, pendingMigrationNames, planRelease } from "./releasePlan.mjs";

const online = (sql) => `-- online: only adds a table the running release never reads\n${sql}`;

assert.deepEqual(planRelease([]), { mode: "overlap", reasons: [] }, "no schema change keeps the old app serving");
assert.deepEqual(
  planRelease([{ name: "053_add_rates.sql", sql: online("CREATE TABLE rates (id INTEGER PRIMARY KEY);") }]),
  { mode: "overlap", reasons: [] },
);
assert.deepEqual(
  planRelease([{ name: "053_add_rates.sql", sql: "CREATE TABLE rates (id INTEGER PRIMARY KEY);" }]),
  { mode: "stop_first", reasons: ["053_add_rates.sql is not marked `-- online:`"] },
  "an unmarked migration is assumed to break the running release",
);

assert.deepEqual(migrationRisks({ sql: online("ALTER TABLE items RENAME COLUMN quantity TO add_to_quantity;") }),
  ["renames a table or column"], "a rename breaks the running release even when marked online");
assert.deepEqual(migrationRisks({ sql: online("ALTER TABLE items DROP COLUMN legacy;") }), ["drops a column"]);
assert.deepEqual(migrationRisks({ sql: online("ALTER TABLE items ALTER COLUMN label SET NOT NULL;") }),
  ["makes a column NOT NULL"]);
assert.deepEqual(migrationRisks({ sql: online("ALTER TABLE items ALTER COLUMN price TYPE NUMERIC(12,2);") }),
  ["changes a column type"]);
assert.deepEqual(migrationRisks({ sql: online("ALTER TABLE items ADD COLUMN source TEXT NOT NULL;") }),
  ["adds a NOT NULL column without a default"]);
assert.deepEqual(migrationRisks({ sql: online("ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'x';") }), [],
  "a required column with a default keeps the running release's inserts working");
assert.deepEqual(migrationRisks({ sql: online("DROP TABLE IF EXISTS pg_temp.scratch;") }), [],
  "dropping a session temp table is not a schema change");
assert.deepEqual(
  migrationRisks({ sql: "-- online: replaces the old column, which nothing reads\n-- we drop column later\nCREATE INDEX i ON t (a);" }),
  [], "comments do not count as statements");

assert.deepEqual(
  planRelease([
    { name: "053_a.sql", sql: online("CREATE TABLE a (id INTEGER);") },
    { name: "054_b.sql", sql: "ALTER TABLE a DROP COLUMN id;" },
  ]).reasons,
  ["054_b.sql is not marked `-- online:`", "054_b.sql drops a column"],
);

assert.deepEqual(
  pendingMigrationNames(["002_b.sql", "001_a.sql", "README.md", "003_c.sql"], ["001_a.sql"]),
  ["002_b.sql", "003_c.sql"],
);

console.log("PASS release plan overlaps the running app only for no migrations or ones marked online without breaking statements");
