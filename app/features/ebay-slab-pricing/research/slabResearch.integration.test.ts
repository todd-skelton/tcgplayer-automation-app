import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { getPool } from "~/core/db/database.server";
import fixture from "../identity/fixtures/alt-cert-110185364.json";
import { parseAltCertificate } from "../identity/altIdentityProvider.server";
import {
  slabIdentityStore,
  slabIdentityService,
} from "../identity/slabIdentities.server";
import {
  loadResearchPlan,
  loadSlabWorkspace,
  researchTarget,
} from "./slabResearch.server";
import {
  getInventory,
  reconcileInventory,
} from "../inventory/slabInventory.server";
import { parseInventoryCsv } from "../inventory/slabInventoryCsv.server";
import {
  requestEvidence,
  claimEvidenceJob,
  completeEvidenceJob,
} from "../evidence/evidenceRefreshStore.server";
import {
  calculateSlabRecommendation,
  getSlabRecommendation,
} from "../valuation/slabRecommendations.server";
import { DEFAULT_SLAB_POLICY } from "../valuation/slabValuation";
import type { SaleEvidence } from "../evidence/slabEvidence";

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
const schema = `slab_workspace_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Workspace navigation must never fetch provider evidence");
};
try {
  for (const migration of [
    "025_add_slab_identities.sql",
    "026_add_slab_inventory.sql",
    "027_add_slab_evidence_refreshes.sql",
    "028_add_slab_comp_decisions.sql",
    "029_add_slab_recommendations.sql",
  ])
    await db.query(await readFile(`db/migrations/${migration}`, "utf8"));
  const candidate = parseAltCertificate(JSON.stringify(fixture))!;
  const saved = await slabIdentityStore.saveCandidate(candidate, candidate, [
    "confirmation-required",
  ]);
  const window = { from: "2026-06-01", to: "2026-09-05" };
  const owned = await loadSlabWorkspace(saved.id, "owned", window);
  const explored = await loadSlabWorkspace(saved.id, "10", window);
  assert.equal(explored.target.identity!.grading.number, 10);
  assert.equal(explored.record.candidate!.identity.grading.number, 1);
  assert.equal(
    (await slabIdentityStore.find(candidate))!.revision,
    saved.revision,
  );
  assert.equal(
    owned.keys[0],
    explored.keys[0],
    "All-grade Alt request is reused",
  );
  assert.notEqual(
    owned.keys[1],
    explored.keys[1],
    "eBay research keys isolate grade",
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM slab_evidence_refreshes"))
      .rows[0].n,
    0,
  );
  assert.throws(() => researchTarget(saved, "9.5"));
  assert.throws(() => researchTarget(saved, "11"));
  const identity = {
    ...candidate.identity,
    card: {
      ...candidate.identity.card,
      language: "English",
      edition: "Unlimited",
      stamp: "None",
    },
  };
  const confirmed = await slabIdentityService.confirm(
    candidate,
    saved.revision,
    identity,
    "Reviewed isolated fixture",
  );
  await assert.rejects(
    () => loadResearchPlan(saved.id, saved.revision, "owned", window),
    /changed/,
  );
  const csv = [
    "item_id,title,price,currency,quantity,state,format,grader,certificate_number",
    ...Array.from(
      { length: 50 },
      (_, i) =>
        `${900000000000 + i},Workspace sample ${i + 1},100,USD,1,active,fixed-price,PSA,110185364`,
    ),
  ].join("\n");
  await reconcileInventory(parseInventoryCsv(csv, "workspace-sample"), 0);
  const first = await getInventory("workspace-sample", "", 25);
  const second = await getInventory("workspace-sample", first.next!, 25);
  assert.equal(
    new Set([...first.items, ...second.items].map((r) => r.id)).size,
    50,
  );
  assert.equal(second.next, null);
  assert.ok(first.items.every((r) => r.identity?.id === confirmed.id));
  const plan = await loadResearchPlan(
    confirmed.id,
    confirmed.revision,
    "owned",
    window,
  );
  const spec = plan.plan.requests.find((s) => s.kind === "alt-sales")!;
  const [status] = await requestEvidence([spec]);
  const job = (await claimEvidenceJob())!;
  const sales: SaleEvidence[] = [100, 110, 120, 130].map((price, i) => ({
    provider: "alt",
    providerId: `sample-${i}`,
    assetId: identity.providerAsset!.id,
    sourceUrl: null,
    sourceReference: null,
    sourceItemId: null,
    venue: "Test",
    kind: "transaction",
    date: `2026-09-0${i + 1}`,
    format: "auction",
    title: null,
    card: identity.card,
    grading: identity.grading,
    certificateNumber: null,
    price: { amount: price, currency: "USD" },
    convertedPrice: null,
    shipping: { amount: 0, currency: "USD" },
    fees: { amount: 0, currency: "USD" },
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
        asOf: "2026-09-05T12:00:00Z",
        coverage: {
          requestedWindow: window,
          observedWindow: { from: "2026-09-01", to: "2026-09-04" },
          complete: false,
          reason: "capped-per-grade",
          sourceCount: 4,
          limitPerGrade: 16,
        },
      },
    },
    3,
  );
  await db.query(
    "UPDATE slab_evidence_revisions SET fetched_at='2026-09-05T12:00:00Z'",
  );
  const input = {
    slabId: confirmed.id,
    identityRevision: confirmed.revision,
    revisionIds: [status.runId],
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
  };
  const recommendation = await calculateSlabRecommendation(
    input,
    "2026-09-05T13:00:00Z",
  );
  assert.ok(recommendation.calculation.market.range);
  assert.equal(recommendation.calculation.market.count, 4);
  const corrected = await slabIdentityService.confirm(
    candidate,
    confirmed.revision,
    {
      ...identity,
      grading: {
        ...identity.grading,
        encoding: "10",
        number: 10,
        label: "PSA 10",
      },
    },
    "Corrected isolated fixture grade",
  );
  assert.equal(
    (await getSlabRecommendation(recommendation.id))!.current,
    false,
  );
  const recalculated = await calculateSlabRecommendation(
    { ...input, identityRevision: corrected.revision },
    "2026-09-05T13:01:00Z",
  );
  assert.equal(recalculated.calculation.market.range, null);
  assert.equal(recalculated.calculation.identity.revision, corrected.revision);
  assert.equal(
    (await loadSlabWorkspace(confirmed.id, "owned", window)).recommendation!.id,
    recalculated.id,
  );
  console.log(
    "PASS workspace research preserves PSA 1 while exploring PSA 10, warm reads make no requests, 50 listings paginate, and corrections invalidate/recalculate recommendations",
  );
} finally {
  globalThis.fetch = originalFetch;
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
