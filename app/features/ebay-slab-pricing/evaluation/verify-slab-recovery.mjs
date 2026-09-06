import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";

// This test uses only databases it creates on the local development PostgreSQL container.
dotenv.config({
  path: [".env.development.local", ".env.local", ".env.development", ".env"],
  quiet: true,
});
const base = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation",
);
assert.ok(
  ["localhost", "127.0.0.1"].includes(base.hostname) &&
    base.port === "5433" &&
    base.pathname === "/tcgplayer_automation",
  "Recovery verification requires the local development database",
);
const run = promisify(execFile),
  container = "tcgplayer-postgres-db";
const inspected = JSON.parse(
  (
    await run("docker", [
      "inspect",
      container,
      "--format",
      "{{json .NetworkSettings.Ports}}",
    ])
  ).stdout,
);
assert.ok(
  inspected["5432/tcp"]?.some((port) => port.HostPort === "5433"),
  "The container must be the configured development PostgreSQL instance",
);
const nonce = randomUUID().replaceAll("-", ""),
  prefix = `slab_recovery_${nonce}_`;
const databaseNames = ["fresh", "upgrade", "restore"].map(
  (name) => prefix + name,
);
const created = [],
  clients = [];
const admin = new pg.Client({ connectionString: base.toString() });
await admin.connect();
const connection = (name) => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};
const connect = async (name) => {
  const client = new pg.Client({ connectionString: connection(name) });
  await client.connect();
  clients.push(client);
  return client;
};
const migrate = async (name) => {
  await run(process.execPath, ["scripts/db-migrate.mjs"], {
    env: { ...process.env, DATABASE_URL: connection(name) },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
};
const restore = (name, archive) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "pg_restore",
        "-U",
        base.username,
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--dbname",
        name,
      ],
      { stdio: ["pipe", "ignore", "pipe"], timeout: 60_000 },
    );
    let error = "";
    child.stderr.on("data", (data) => {
      error = (error + data.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Fixture restore failed (${code}): ${error}`)),
    );
    child.stdin.end(archive);
  });
const snapshot = async (db) => {
  const tables = (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const result = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z0-9_]+$/);
    result[tablename] = (
      await db.query(
        `SELECT count(*)::int AS count, md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text),'')) AS checksum FROM "${tablename}" t`,
      )
    ).rows[0];
  }
  return result;
};
try {
  for (const name of databaseNames) {
    assert.ok(name.startsWith(prefix) && /^[a-z0-9_]+$/.test(name));
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
  }
  const [freshName, upgradeName, restoreName] = databaseNames;
  await migrate(freshName);
  const fresh = await connect(freshName),
    freshState = await snapshot(fresh);
  await migrate(freshName);
  assert.deepEqual(
    await snapshot(fresh),
    freshState,
    "Fresh migration reruns must not change data",
  );
  assert.equal(freshState.slab_maintenance_settings.count, 0);
  assert.equal(freshState.slab_provider_connections.count, 0);
  assert.equal(freshState.slab_publications.count, 0);

  const upgrade = await connect(upgradeName);
  await upgrade.query(
    "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  );
  const migrations = (await readdir("db/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of migrations.filter(
    (name) => Number(name.slice(0, 3)) <= 23,
  )) {
    await upgrade.query("BEGIN");
    try {
      await upgrade.query(await readFile(`db/migrations/${file}`, "utf8"));
      await upgrade.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        file,
      ]);
      await upgrade.query("COMMIT");
    } catch (error) {
      await upgrade.query("ROLLBACK");
      throw error;
    }
  }
  await upgrade.query(
    "INSERT INTO product_lines(product_line_id,product_line_name,product_line_url_name,is_direct) VALUES(999999,'Synthetic recovery marker','synthetic-recovery-marker',false)",
  );
  const legacy = await snapshot(upgrade);
  await migrate(upgradeName);
  const upgraded = await snapshot(upgrade);
  for (const [table, value] of Object.entries(legacy)) {
    if (table !== "schema_migrations")
      assert.deepEqual(upgraded[table], value, `Upgrade preserves ${table}`);
  }
  assert.equal(upgraded.schema_migrations.count, migrations.length);
  const ids = Object.fromEntries(
    [
      "identity",
      "inventory",
      "evidence",
      "scan",
      "recommendation",
      "preview",
      "publication",
    ].map((name) => [name, randomUUID()]),
  );
  const key = "a".repeat(64),
    version = "b".repeat(64),
    seller = "synthetic-recovery-fixture";
  // Structural fixtures exercise the reference graph, not pricing accuracy or provider responses.
  await upgrade.query(
    "INSERT INTO slab_identities(id,grader,certificate_number) VALUES($1,'PSA','RECOVERY-FIXTURE')",
    [ids.identity],
  );
  await upgrade.query(
    "INSERT INTO slab_inventory_accounts(seller) VALUES($1)",
    [seller],
  );
  await upgrade.query(
    "INSERT INTO slab_inventory(id,seller,item_id,snapshot,source,state,identity_id,observed_at) VALUES($1,$2,'900000000077','{\"title\":\"Synthetic recovery fixture\"}','csv','active',$3,clock_timestamp())",
    [ids.inventory, seller, ids.identity],
  );
  await upgrade.query(
    "INSERT INTO slab_supply_versions(hash,listing_key,payload) VALUES($1,'synthetic-supply','{\"synthetic\":true}')",
    [version],
  );
  await upgrade.query(
    "INSERT INTO slab_supply_scans(id,source_key,provider,captured_at,complete,reported_count,stored_count,content_hash) VALUES($1,$2,'alt',clock_timestamp(),false,1,1,$3)",
    [ids.scan, key, version],
  );
  await upgrade.query(
    "INSERT INTO slab_supply_observations(scan_id,listing_key,version_hash,position) VALUES($1,'synthetic-supply',$2,0)",
    [ids.scan, version],
  );
  await upgrade.query(
    "INSERT INTO slab_evidence_refreshes(key,spec,state,run_id) VALUES($1,'{\"synthetic\":true}','idle',$2)",
    [key, ids.evidence],
  );
  await upgrade.query(
    "INSERT INTO slab_evidence_revisions(id,key,payload,fetched_at,byte_count,observation_count,retained,supply_scan_id) VALUES($1,$2,'{\"synthetic\":true}',clock_timestamp(),18,1,true,$3)",
    [ids.evidence, key, ids.scan],
  );
  await upgrade.query(
    "UPDATE slab_evidence_refreshes SET latest_revision=$2 WHERE key=$1",
    [key, ids.evidence],
  );
  await upgrade.query(
    "INSERT INTO slab_recommendations(id,input_key,slab_id,identity_revision,valuation_group_key,calculation) VALUES($1,$2,$3,1,'synthetic','{\"synthetic\":true}')",
    [ids.recommendation, version, ids.identity],
  );
  await upgrade.query(
    "INSERT INTO slab_recommendation_evidence(recommendation_id,revision_id) VALUES($1,$2)",
    [ids.recommendation, ids.evidence],
  );
  await upgrade.query(
    "INSERT INTO slab_price_overrides(recommendation_id,item_price,currency,note) VALUES($1,125,'USD','Synthetic reviewed ask')",
    [ids.recommendation],
  );
  await upgrade.query(
    "INSERT INTO slab_publication_previews(id,inventory_id,recommendation_id,request,plan,expires_at) VALUES($1,$2,$3,'{}','{\"synthetic\":true}',clock_timestamp()+interval '5 minutes')",
    [ids.preview, ids.inventory, ids.recommendation],
  );
  await upgrade.query(
    "INSERT INTO slab_publications(id,preview_id,seller,item_id,variation_key,mode,plan,state,write_started_at) VALUES($1,$2,$3,'900000000077','','live','{\"synthetic\":true}','reconcile',clock_timestamp())",
    [ids.publication, ids.preview, seller],
  );
  await upgrade.query(
    "INSERT INTO slab_publication_events(publication_id,state,reason) VALUES($1,'reconcile','synthetic-uncertain-response')",
    [ids.publication],
  );
  await upgrade.query(
    "INSERT INTO slab_maintenance_settings(seller,enabled) VALUES($1,true)",
    [seller],
  );
  await upgrade.query(
    "INSERT INTO slab_maintenance_items(inventory_id,inventory_revision,identity_revision,recommendation_id,outcome,reason,next_check_at,settings_revision) VALUES($1,1,1,$2,'review-required','synthetic',clock_timestamp(),1)",
    [ids.inventory, ids.recommendation],
  );
  const before = await snapshot(upgrade);
  const archive = (
    await run(
      "docker",
      [
        "exec",
        container,
        "pg_dump",
        "-U",
        base.username,
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--dbname",
        upgradeName,
      ],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
    )
  ).stdout;
  await restore(restoreName, archive);
  const restored = await connect(restoreName);
  assert.deepEqual(
    await snapshot(restored),
    before,
    "Every table and row must survive backup/restore",
  );
  await migrate(restoreName);
  assert.deepEqual(
    await snapshot(restored),
    before,
    "Migrations remain idempotent after restore",
  );
  await assert.rejects(
    () =>
      restored.query("DELETE FROM slab_evidence_revisions WHERE id=$1", [
        ids.evidence,
      ]),
    (error) => error.code === "23503",
    "Restored references still protect retained evidence",
  );
  await assert.rejects(
    () =>
      restored.query(
        "INSERT INTO slab_publications(id,preview_id,seller,item_id,variation_key,mode,plan,state) VALUES($1,$2,$3,'900000000077','','live','{}','approved')",
        [randomUUID(), ids.preview, seller],
      ),
    (error) => error.code === "23505",
    "Unresolved publication still holds its listing after restore",
  );
  const next = (
    await restored.query(
      "INSERT INTO slab_publication_events(publication_id,state,reason) VALUES($1,'reconcile','synthetic-post-restore-check') RETURNING sequence",
      [ids.publication],
    )
  ).rows[0].sequence;
  assert.equal(
    Number(next),
    2,
    "Audit sequence resumes without overwriting earlier events",
  );
  await restored.query(
    "UPDATE slab_maintenance_settings SET enabled=false,revision=revision+1,lease_id=NULL,lease_until=NULL",
  );
  assert.equal(
    (
      await restored.query(
        "SELECT count(*)::int AS n FROM slab_maintenance_settings WHERE enabled",
      )
    ).rows[0].n,
    0,
  );
  assert.ok(
    (
      await restored.query(
        "SELECT write_started_at FROM slab_publications WHERE id=$1 AND state='reconcile'",
        [ids.publication],
      )
    ).rows[0].write_started_at,
    "Pausing after restore does not erase a possible external write",
  );
  console.log(
    `PASS ${migrations.length} fresh/idempotent migrations, upgrade from 23 preserving existing tables, ${Object.keys(before).length}-table backup/restore (${archive.length} archive bytes), retained evidence graph, manual ask, publication lock/sequence and maintenance pause`,
  );
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
  try {
    for (const name of created.reverse()) {
      assert.ok(
        databaseNames.includes(name) &&
          name.startsWith(prefix) &&
          /^[a-z0-9_]+$/.test(name),
      );
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
