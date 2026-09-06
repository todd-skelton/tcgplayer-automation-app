import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import Papa from "papaparse";
import { getPool } from "~/core/db/database.server";
import certFixture from "../identity/fixtures/alt-cert-110185364.json";
import { parseAltCertificate } from "../identity/altIdentityProvider.server";
import {
  slabIdentityStore,
  slabIdentityService,
} from "../identity/slabIdentities.server";
import { parseInventoryCsv } from "../inventory/slabInventoryCsv.server";
import {
  reconcileInventory,
  getInventory,
} from "../inventory/slabInventory.server";
import {
  claimEvidenceJob,
  completeEvidenceJob,
} from "../evidence/evidenceRefreshStore.server";
import type { SaleEvidence } from "../evidence/slabEvidence";
import {
  calculateSlabRecommendation,
  getSlabRecommendation,
  overrideSlabPrice,
} from "../valuation/slabRecommendations.server";
import { DEFAULT_SLAB_POLICY } from "../valuation/slabValuation";
import { defaultMaintenanceSettings } from "./slabMaintenance";
import {
  getMaintenanceSettings,
  saveMaintenanceSettings,
  claimMaintenance,
  maintenanceActive,
  maintenanceCheckpoint,
} from "./slabMaintenanceStore.server";
import {
  maintenanceWindow,
  runSlabMaintenanceCycle,
} from "./slabMaintenanceCycle.server";
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
const schema = `slab_maintenance_test_${randomUUID().replaceAll("-", "")}`,
  admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
process.env.WORKERS_RUN_IN_PROCESS = "false";
const db = getPool(),
  originalFetch = globalThis.fetch;
let remote = 0;
globalThis.fetch = async () => {
  remote++;
  throw new Error("Maintenance must only enqueue fixture evidence");
};
try {
  for (const file of [
    "024_add_slab_provider_connections.sql",
    "025_add_slab_identities.sql",
    "026_add_slab_inventory.sql",
    "027_add_slab_evidence_refreshes.sql",
    "028_add_slab_comp_decisions.sql",
    "029_add_slab_recommendations.sql",
    "030_add_slab_supply_observations.sql",
    "031_add_slab_publication_previews.sql",
    "032_add_slab_publications.sql",
    "033_add_slab_evidence_maintenance.sql",
  ])
    await db.query(await readFile(`db/migrations/${file}`, "utf8"));
  const seller = "maintenance-fixture";
  assert.equal((await getMaintenanceSettings(seller)).enabled, false);
  assert.equal(await runSlabMaintenanceCycle(), null);
  const candidate = parseAltCertificate(JSON.stringify(certFixture))!;
  candidate.identity.card = {
    ...candidate.identity.card,
    language: "English",
    edition: "Unlimited",
    stamp: "None",
  };
  const identities = [];
  for (let n = 0; n < 6; n++) {
    const value = { ...candidate, certificateNumber: `MAINTENANCE-${n}` };
    const row = await slabIdentityStore.saveCandidate(value, value, [
      "fixture",
    ]);
    identities.push(
      await slabIdentityService.confirm(
        value,
        row.revision,
        value.identity,
        "Synthetic maintenance fixture",
      ),
    );
  }
  await reconcileInventory(
    parseInventoryCsv(
      Papa.unparse(
        identities.map((identity, n) => ({
          item_id: String(900000000000 + n),
          title: "Hitmonlee maintenance fixture",
          price: 100,
          currency: "USD",
          quantity: 1,
          state: "active",
          format: "fixed-price",
          grader: "PSA",
          certificate_number: identity.certificateNumber,
          shipping_amount: 0,
          shipping_currency: "USD",
        })),
      ),
      seller,
    ),
    0,
  );
  await db.query(
    "INSERT INTO slab_provider_connections(provider,credential,status) VALUES('alt','SYNTHETIC','connected')",
  );
  const settings = await saveMaintenanceSettings({
    ...defaultMaintenanceSettings(seller),
    enabled: true,
    batchSize: 3,
    refreshBudget: 1,
  });
  await assert.rejects(
    () => saveMaintenanceSettings({ ...settings, revision: 0 }),
    /changed/,
  );
  const first = (await runSlabMaintenanceCycle())!;
  assert.equal(first.checked, 3);
  assert.equal(first.requested, 1);
  assert.equal(first.queued, 1);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM slab_evidence_refreshes WHERE state='queued'",
      )
    ).rows[0].n,
    1,
    "Shared valuation groups enqueue one source job",
  );
  const job = (await claimEvidenceJob())!;
  assert.ok(job.spec.kind === "alt-sales");
  const window = maintenanceWindow(),
    sales: SaleEvidence[] = [100, 110, 120, 130].map((amount, n) => ({
      provider: "alt",
      providerId: `maintenance-sale-${n}`,
      assetId: candidate.identity.providerAsset!.id,
      sourceUrl: null,
      sourceReference: null,
      sourceItemId: null,
      venue: "Synthetic",
      kind: "transaction",
      date: window.to,
      format: "auction",
      title: null,
      card: candidate.identity.card,
      grading: candidate.identity.grading,
      certificateNumber: null,
      price: { amount, currency: "USD" },
      convertedPrice: null,
      shipping: { amount: 0, currency: "USD" },
      fees: null,
      shippingIncluded: false,
      buyerPremiumIncluded: false,
      quantity: 1,
      subjectToChange: false,
      skippedReason: null,
    }));
  await completeEvidenceJob(
    job,
    {
      kind: "alt-sales",
      data: {
        sales,
        asOf: new Date().toISOString(),
        coverage: {
          requestedWindow: window,
          observedWindow: { from: window.to, to: window.to },
          complete: false,
          reason: "capped-per-grade",
          sourceCount: 4,
          limitPerGrade: 16,
        },
      },
    },
    1,
  );
  for (const identity of identities)
    await calculateSlabRecommendation({
      slabId: identity.id,
      identityRevision: identity.revision,
      revisionIds: [job.runId],
      policy: DEFAULT_SLAB_POLICY,
      seller: {
        currency: "USD",
        currentAsk: 100,
        shippingCharged: 0,
        shippingCost: null,
        acquisitionCost: null,
        fees: null,
        minimumAsk: null,
        minimumProfit: null,
      },
    });
  const tick = async (all = false) => {
    await db.query(
      "UPDATE slab_maintenance_settings SET next_cycle_at=clock_timestamp() WHERE seller=$1",
      [seller],
    );
    if (all)
      await db.query(
        "UPDATE slab_maintenance_items SET next_check_at=clock_timestamp()",
      );
    return (await runSlabMaintenanceCycle())!;
  };
  assert.equal((await tick()).recalculated, 3);
  assert.equal((await tick()).recalculated, 3);
  const count = (
    await db.query("SELECT count(*)::int AS n FROM slab_recommendations")
  ).rows[0].n;
  assert.equal((await tick(true)).recalculated, 0);
  assert.equal((await tick()).recalculated, 0);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM slab_recommendations"))
      .rows[0].n,
    count,
    "Warm unchanged cycles do not create recommendation churn",
  );
  assert.equal(await claimEvidenceJob(), null);
  const inventory = (await getInventory(seller, "", 25)).items;
  const latest = (
    await db.query(
      "SELECT recommendation_id FROM slab_maintenance_items WHERE inventory_id=$1",
      [inventory[0].id],
    )
  ).rows[0].recommendation_id;
  await overrideSlabPrice({
    recommendationId: latest,
    itemPrice: 125,
    currency: "USD",
    note: "Preserve the reviewed price",
  });
  const reviewed = (await getSlabRecommendation(latest))!;
  const recalculate = (saved: typeof reviewed, currentAsk: number) =>
    calculateSlabRecommendation(
      {
        slabId: saved.calculation.identity.slabId,
        identityRevision: saved.calculation.identity.revision,
        revisionIds: saved.calculation.evidence.map((e) => e.revisionId),
        policy: saved.calculation.policy,
        seller: { ...saved.calculation.seller, currentAsk },
      },
      undefined,
      { expectedRecommendationId: saved.id },
    );
  await assert.rejects(() => recalculate(reviewed, 101), /reviewed price/);
  const otherId = (
    await db.query(
      "SELECT recommendation_id FROM slab_maintenance_items WHERE inventory_id=$1",
      [inventory[1].id],
    )
  ).rows[0].recommendation_id;
  const other = (await getSlabRecommendation(otherId))!;
  const raced = await Promise.allSettled([
    overrideSlabPrice({
      recommendationId: otherId,
      itemPrice: 127,
      currency: "USD",
      note: "Concurrent manual review",
    }),
    recalculate(other, 101),
  ]);
  assert.equal(
    raced.filter((result) => result.status === "fulfilled").length,
    1,
    "Manual review and automatic replacement cannot both succeed from one recommendation",
  );
  if (raced[0].status === "fulfilled") {
    assert.equal(
      (
        await db.query(
          "SELECT id FROM slab_recommendations WHERE slab_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [other.calculation.identity.slabId],
        )
      ).rows[0].id,
      otherId,
      "An accepted manual price remains the latest recommendation",
    );
  } else {
    await assert.rejects(() => recalculate(other, 102), /changed/);
    await assert.rejects(
      () =>
        overrideSlabPrice({
          recommendationId: otherId,
          itemPrice: 127,
          currency: "USD",
          note: "Stale review",
        }),
      /changed/,
    );
  }
  await tick(true);
  await tick();
  assert.equal(
    (
      await db.query(
        "SELECT reason FROM slab_maintenance_items WHERE inventory_id=$1",
        [inventory[0].id],
      )
    ).rows[0].reason,
    "reviewed-price-held",
  );
  await db.query(
    "UPDATE slab_provider_connections SET status='reconnect-required' WHERE provider='alt'",
  );
  await db.query(
    "UPDATE slab_evidence_refreshes SET expires_at=clock_timestamp()-interval '1 second'",
  );
  await db.query(
    "INSERT INTO slab_provider_connections(provider,credential,user_agent,status) VALUES('ebayResearch','SYNTHETIC','fixture','connected')",
  );
  const failedSource = await tick(true);
  assert.equal(failedSource.requested, 1);
  assert.equal(
    (
      await db.query(
        "SELECT spec->>'kind' AS kind FROM slab_evidence_refreshes WHERE state='queued'",
      )
    ).rows[0].kind,
    "ebay-sales",
    "One expired provider does not block another provider's queue",
  );
  await db.query(
    "UPDATE slab_maintenance_settings SET next_cycle_at=clock_timestamp() WHERE seller=$1",
    [seller],
  );
  const [a, b] = await Promise.all([claimMaintenance(), claimMaintenance()]);
  const claimed = a ?? b;
  assert.ok(claimed);
  assert.ok(!a || !b);
  await db.query(
    "UPDATE slab_maintenance_settings SET lease_until=clock_timestamp()-interval '1 second' WHERE seller=$1",
    [seller],
  );
  const replacement = await claimMaintenance();
  assert.ok(replacement);
  assert.equal(await maintenanceActive(claimed), false);
  const previous = await getMaintenanceSettings(seller);
  await saveMaintenanceSettings({ ...previous, enabled: false });
  assert.equal(await maintenanceActive(replacement), false);
  assert.equal(await runSlabMaintenanceCycle(), null);
  await maintenanceCheckpoint(claimed, {
    inventoryId: inventory[0].id,
    inventoryRevision: 999,
    identityRevision: null,
    inputKey: null,
    recommendationId: null,
    outcome: "invalid",
    reason: "stale",
    waiting: false,
  });
  assert.notEqual(
    (
      await db.query(
        "SELECT inventory_revision FROM slab_maintenance_items WHERE inventory_id=$1",
        [inventory[0].id],
      )
    ).rows[0].inventory_revision,
    999,
    "A stale lease cannot overwrite its checkpoint",
  );
  const largeSeller = "maintenance-large-fixture";
  await reconcileInventory(
    parseInventoryCsv(
      Papa.unparse(
        Array.from({ length: 5000 }, (_, n) => ({
          item_id: String(910000000000 + n),
          title: "Unconfirmed synthetic slab",
          price: 100,
          currency: "USD",
          quantity: 1,
          state: "active",
          format: "fixed-price",
        })),
      ),
      largeSeller,
    ),
    0,
  );
  await saveMaintenanceSettings({
    ...defaultMaintenanceSettings(largeSeller),
    enabled: true,
    batchSize: 25,
    refreshBudget: 1,
  });
  const timings: number[] = [];
  for (let n = 0; n < 5; n++) {
    await db.query(
      "UPDATE slab_maintenance_settings SET next_cycle_at=clock_timestamp() WHERE seller=$1",
      [largeSeller],
    );
    const started = performance.now(),
      cycle = (await runSlabMaintenanceCycle())!;
    timings.push(performance.now() - started);
    assert.equal(cycle.checked, 25);
    assert.equal(cycle.requested, 0);
    assert.equal(cycle.recalculated, 0);
  }
  timings.sort((a, b) => a - b);
  console.log(
    `5,000-listing fixture / 25-listing cycles: p50 ${timings[2].toFixed(1)} ms, max ${timings[4].toFixed(1)} ms; zero remote requests`,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM slab_publications")).rows[0]
      .n,
    0,
  );
  assert.equal(remote, 0);
  console.log(
    "PASS opt-in maintenance, bounded/coalesced refresh, unchanged warm cycles, reviewed-price hold, source isolation, leases, pause and zero publication",
  );
} finally {
  globalThis.fetch = originalFetch;
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
