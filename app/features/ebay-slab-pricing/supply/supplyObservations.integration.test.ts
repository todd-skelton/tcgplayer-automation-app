import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { getPool, withTransaction } from "~/core/db/database.server";
import {
  recordSupplyScan,
  getSupplyScan,
  previousSupplyScan,
  cleanSupplyObservations,
} from "./supplyObservations.server";
import { compareSupplyScans } from "./supplyContext";
import {
  requestEvidence,
  claimEvidenceJob,
  completeEvidenceJob,
  cancelEvidenceRefresh,
  getEvidenceRevision,
  type EvidenceJob,
} from "../evidence/evidenceRefreshStore.server";
import {
  evidenceKey,
  type EvidencePayload,
} from "../evidence/evidenceRefreshProvider.server";
import type { EvidenceSpec } from "../evidence/evidenceRefresh";
import type { SupplyEvidence } from "../evidence/slabEvidence";
dotenv.config({
  path: [".env.development.local", ".env.local", ".env.development", ".env"],
  quiet: true,
});
const url = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation",
);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.port === "5433" &&
    url.pathname === "/tcgplayer_automation",
);
const schema = `slab_supply_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool();
try {
  for (const migration of [
    "027_add_slab_evidence_refreshes.sql",
    "030_add_slab_supply_observations.sql",
  ])
    await db.query(await readFile(`db/migrations/${migration}`, "utf8"));
  const spec: EvidenceSpec = { kind: "alt-supply", assetId: "supply-fixture" };
  const job = (): EvidenceJob => ({
    key: evidenceKey(spec),
    spec,
    runId: randomUUID(),
    leaseId: randomUUID(),
    attempts: 1,
  });
  const listings: SupplyEvidence[] = Array.from({ length: 50 }, (_, i) => ({
    provider: "alt",
    providerId: `fixture-${i}`,
    assetId: "supply-fixture",
    venue: "Alt",
    sourceUrl: null,
    title: `Synthetic supply ${i}`,
    format: "FIXED_PRICE",
    state: "ACTIVE",
    price: { amount: 25 + i, currency: "USD" },
    priceKind: "ask",
    shipping: { amount: 0, currency: "USD" },
    quantity: 1,
    startedAt: "2021-01-01",
    endsAt: null,
    items: [],
  }));
  const asOf = new Date(Date.now() - 205 * 60000).toISOString();
  const payload: Extract<EvidencePayload, { kind: "alt-supply" }> = {
    kind: "alt-supply",
    data: { listings, asOf, scope: "alt-only", complete: false },
  };
  const first = job();
  await withTransaction((client) => recordSupplyScan(client, first, payload));
  await withTransaction((client) => recordSupplyScan(client, first, payload));
  const count = async (table: string) =>
    Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  assert.equal(await count("slab_supply_scans"), 1);
  assert.equal(await count("slab_supply_versions"), 50);
  const second = job(),
    next = {
      ...payload,
      data: {
        ...payload.data,
        asOf: new Date(Date.parse(asOf) + 60000).toISOString(),
      },
    };
  await withTransaction((client) => recordSupplyScan(client, second, next));
  assert.equal(
    await count("slab_supply_versions"),
    50,
    "Unchanged listing payloads are reused across scans",
  );
  assert.equal(await count("slab_supply_observations"), 100);
  assert.equal(
    (await previousSupplyScan(first.key, next.data.asOf))!.id,
    first.runId,
  );
  assert.equal(
    compareSupplyScans(
      (await getSupplyScan(first.runId))!,
      (await getSupplyScan(second.runId))!,
    ).changes.length,
    0,
  );
  const third = job(),
    changed = {
      ...next,
      data: {
        ...next.data,
        asOf: new Date(Date.parse(asOf) + 120000).toISOString(),
        listings: [
          { ...listings[0], price: { amount: 99, currency: "USD" } },
          ...listings.slice(1),
        ],
      },
    };
  await withTransaction((client) => recordSupplyScan(client, third, changed));
  assert.equal(
    await count("slab_supply_versions"),
    51,
    "Only the changed payload gets another version",
  );
  assert.equal(
    compareSupplyScans(
      (await getSupplyScan(second.runId))!,
      (await getSupplyScan(third.runId))!,
    ).changes[0].kind,
    "observed-price-change",
  );
  await assert.rejects(
    () => withTransaction((client) => recordSupplyScan(client, first, next)),
    /content changed/,
  );
  await assert.rejects(
    () =>
      withTransaction((client) =>
        recordSupplyScan(client, job(), {
          ...payload,
          data: {
            ...payload.data,
            listings: [
              listings[0],
              { ...listings[0], price: { amount: 1, currency: "USD" } },
            ],
          },
        }),
      ),
    /contradictory/,
  );
  assert.equal(await count("slab_supply_scans"), 3);
  await requestEvidence([spec]);
  for (const [scanId, retained] of [
    [first.runId, true],
    [second.runId, false],
  ] as const)
    await db.query(
      `INSERT INTO slab_evidence_revisions(id,key,payload,fetched_at,byte_count,observation_count,retained,supply_scan_id) VALUES($1,$2,$3,$4,100,50,$5,$1)`,
      [
        scanId,
        first.key,
        JSON.stringify({
          kind: "alt-supply",
          data: { asOf, scope: "alt-only", complete: false },
        }),
        asOf,
        retained,
      ],
    );
  const started = performance.now();
  for (let i = 3; i < 203; i++)
    await withTransaction((client) =>
      recordSupplyScan(client, job(), {
        ...payload,
        data: {
          ...payload.data,
          asOf: new Date(Date.parse(asOf) + i * 60000).toISOString(),
        },
      }),
    );
  assert.equal(
    await count("slab_supply_scans"),
    201,
    "The latest 200 scans are bounded; a retained older revision survives",
  );
  assert.equal(await count("slab_supply_observations"), 10050);
  assert.equal(
    await getEvidenceRevision(second.runId),
    null,
    "Old unretained source history is evicted with its scan",
  );
  assert.ok(
    await getEvidenceRevision(first.runId),
    "Retained source history remains readable",
  );
  assert.equal(await count("slab_supply_versions"), 51);
  console.log(
    `Supply archive: 200 scans plus one retained / 10,050 references reuse 51 listing payloads; append workload ${Math.round(performance.now() - started)}ms.`,
  );
  await requestEvidence([spec]);
  const cancelled = (await claimEvidenceJob())!;
  await cancelEvidenceRefresh(cancelled.key, cancelled.runId);
  assert.equal(await completeEvidenceJob(cancelled, payload, 1), false);
  assert.equal(
    await getSupplyScan(cancelled.runId),
    null,
    "Cancelled leases never append observations",
  );
  await requestEvidence([spec], { force: true });
  const active = (await claimEvidenceJob())!;
  const current = {
    ...payload,
    data: { ...payload.data, asOf: new Date().toISOString() },
  };
  assert.equal(await completeEvidenceJob(active, current, 1), true);
  assert.equal((await getSupplyScan(active.runId))!.listings.length, 50);
  const stored = (
    await db.query(
      "SELECT payload,supply_scan_id FROM slab_evidence_revisions WHERE id=$1",
      [active.runId],
    )
  ).rows[0];
  assert.equal(
    stored.payload.data.listings,
    undefined,
    "Cache revisions reference listing versions instead of duplicating payloads",
  );
  assert.equal(stored.supply_scan_id, active.runId);
  const hydrated = await getEvidenceRevision(active.runId);
  assert.ok(hydrated?.payload.kind === "alt-supply");
  assert.deepEqual(
    hydrated.payload.data.listings.map((r) => r.providerId),
    listings.map((r) => r.providerId),
    "Read API preserves source order",
  );
  await db.query(
    "UPDATE slab_supply_scans SET captured_at=clock_timestamp()-interval '181 days'",
  );
  await withTransaction(cleanSupplyObservations);
  assert.equal(
    await count("slab_supply_scans"),
    2,
    "Cache and retained references survive archive cleanup",
  );
  assert.ok(await getEvidenceRevision(active.runId));
  await db.query(
    "UPDATE slab_evidence_refreshes SET latest_revision=NULL WHERE key=$1",
    [active.key],
  );
  await db.query("DELETE FROM slab_evidence_revisions WHERE key=$1", [
    active.key,
  ]);
  await withTransaction(cleanSupplyObservations);
  assert.equal(await count("slab_supply_scans"), 0);
  assert.equal(await count("slab_supply_versions"), 0);
  console.log(
    "PASS incremental supply history, idempotent immutable scans, partial coverage, changed-price versions, bounded retention and cancellation fencing",
  );
} finally {
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
