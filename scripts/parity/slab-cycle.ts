// Records Node's slab maintenance cycle (runSlabMaintenanceCycle) for `slab_pricing::maintenance_cycle`'s
// `cycles_run_as_node_runs_them`, at a fixed time (2026-10-31T18:00:00.000Z; the database's clock
// still runs, as leases and checks read it).
//
// First Node's own identity, inventory and evidence functions build a seller's listings: confirmed
// slabs priced in USD, one priced in CAD, one listed two at a time, one unconfirmed, one with no
// certificate and one ended, with Alt sales evidence for their card and both providers connected.
// That world is dumped, its times fixed, to tests/fixtures/node/slab/cycle-seed.sql, which both
// sides replay. Then recommendations are calculated for five of the slabs, one is given a reviewed
// price (cycle-after-calculations.sql), and four cycles run: the first, one with every listing due
// again, one with the evidence expired, and one with nothing due. Each cycle's summary and
// everything saved (cycle-capture.sql) is written to cycle.node.json. No provider is called.
//
//   node scripts/parity/slab-cycle.mjs
import { readFileSync, writeFileSync } from "node:fs";

if (!process.env.DATABASE_URL?.endsWith("/slab_parity")) throw new Error("Run through scripts/parity/slab-cycle.mjs");
const AT = "2026-10-31T18:00:00.000Z";
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length) super(...args);
    else super(AT);
  }
  static now() {
    return RealDate.parse(AT);
  }
}
globalThis.Date = FixedDate as DateConstructor;
const remoteFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("The cycle must not call a provider");
};

const OUT = "tests/fixtures/node/slab";
const Papa = (await import("papaparse")).default;
const { getPool } = await import("~/core/db/database.server");
const certFixture = JSON.parse(readFileSync("app/features/ebay-slab-pricing/identity/fixtures/alt-cert-110185364.json", "utf8"));
const { parseAltCertificate } = await import("~/features/ebay-slab-pricing/identity/altIdentityProvider.server");
const { slabIdentityStore, slabIdentityService } = await import("~/features/ebay-slab-pricing/identity/slabIdentities.server");
const { parseInventoryCsv } = await import("~/features/ebay-slab-pricing/inventory/slabInventoryCsv.server");
const { reconcileInventory } = await import("~/features/ebay-slab-pricing/inventory/slabInventory.server");
const { requestEvidence, claimEvidenceJob, completeEvidenceJob } = await import("~/features/ebay-slab-pricing/evidence/evidenceRefreshStore.server");
const { calculateSlabRecommendation } = await import("~/features/ebay-slab-pricing/valuation/slabRecommendations.server");
const { DEFAULT_SLAB_POLICY } = await import("~/features/ebay-slab-pricing/valuation/slabValuation");
const { defaultMaintenanceSettings } = await import("~/features/ebay-slab-pricing/maintenance/slabMaintenance");
const { saveMaintenanceSettings } = await import("~/features/ebay-slab-pricing/maintenance/slabMaintenanceStore.server");
const { maintenanceWindow, runSlabMaintenanceCycle } = await import("~/features/ebay-slab-pricing/maintenance/slabMaintenanceCycle.server");
const pool = getPool();

// The world, built as the app builds it.
const seller = "maintenance-fixture";
const candidate = parseAltCertificate(JSON.stringify(certFixture))!;
candidate.identity.card = { ...candidate.identity.card, language: "English", edition: "Unlimited", stamp: "None" };
const identities = [];
for (let n = 0; n < 7; n++) {
  const value = { ...candidate, certificateNumber: `MAINTENANCE-${n}` };
  const row = await slabIdentityStore.saveCandidate(value, value, ["fixture"]);
  // The last stays a candidate, its identity unconfirmed.
  identities.push(n < 6 ? await slabIdentityService.confirm(value, row.revision, value.identity, "Synthetic maintenance fixture") : row);
}
const listing = (n: number, cert: string | null, extra: Record<string, unknown> = {}) => ({
  item_id: String(900000000000 + n),
  title: "Hitmonlee maintenance fixture",
  price: 100,
  currency: "USD",
  quantity: 1,
  state: "active",
  format: "fixed-price",
  grader: cert ? "PSA" : "",
  certificate_number: cert ?? "",
  shipping_amount: 4.99,
  shipping_currency: "USD",
  ...extra,
});
const rows = [
  listing(0, "MAINTENANCE-0"),
  listing(1, "MAINTENANCE-1"),
  listing(2, "MAINTENANCE-2"),
  listing(3, "MAINTENANCE-3"),
  listing(4, "MAINTENANCE-4", { currency: "CAD" }),
  listing(5, "MAINTENANCE-5", { quantity: 2 }),
  listing(6, "MAINTENANCE-6"),
  listing(7, null),
  listing(8, null, { state: "ended" }),
];
await reconcileInventory(parseInventoryCsv(Papa.unparse(rows), seller), 0);
await pool.query("INSERT INTO slab_provider_connections(provider,credential,user_agent,status) VALUES('alt','SYNTHETIC','','connected'),('ebayResearch','SYNTHETIC','fixture','connected')");
await saveMaintenanceSettings({ ...defaultMaintenanceSettings(seller), enabled: true, batchSize: 10, refreshBudget: 2 });
const window = maintenanceWindow();
const assetId = candidate.identity.providerAsset!.id;
await requestEvidence([{ kind: "alt-sales", assetId, window, limitPerGrade: 16 }]);
const job = (await claimEvidenceJob())!;
const sales = [100, 110, 120, 130].map((amount, n) => ({
  provider: "alt", providerId: `maintenance-sale-${n}`, assetId, sourceUrl: null, sourceReference: null, sourceItemId: null,
  venue: "Synthetic", kind: "transaction", date: window.to, format: "auction", title: null, card: candidate.identity.card,
  grading: candidate.identity.grading, certificateNumber: null, price: { amount, currency: "USD" }, convertedPrice: null,
  shipping: { amount: 0, currency: "USD" }, fees: null, shippingIncluded: false, buyerPremiumIncluded: false, quantity: 1,
  subjectToChange: false, skippedReason: null,
}));
await completeEvidenceJob(job, { kind: "alt-sales", data: { sales, asOf: AT, coverage: {
  requestedWindow: window, observedWindow: { from: window.to, to: window.to }, complete: false, reason: "capped-per-grade",
  sourceCount: 4, limitPerGrade: 16 } } } as never, 1);

// Dumped with its times fixed: evidence fetched six hours before the cycle and good until 2099,
// the seller's maintenance due, no lease held.
const TABLES = ["slab_provider_connections", "slab_identities", "slab_inventory_accounts", "slab_inventory",
  "slab_evidence_refreshes", "slab_evidence_revisions", "slab_maintenance_settings"];
const earlier = new RealDate(RealDate.parse(AT) - 6 * 3600_000).toISOString();
const fixedTime = (column: string, value: unknown) => {
  if (value === null || value === "-infinity") return value;
  if (column === "expires_at") return "2099-01-01T00:00:00.000Z";
  if (column === "next_cycle_at") return "2000-01-01T00:00:00.000Z";
  if (column === "lease_until") return null;
  return earlier;
};
let seed = `-- The seller's listings for the recorded slab maintenance cycles (scripts/parity/slab-cycle.ts):
-- built by Node's identity, inventory and evidence functions, dumped with their times fixed. Every
-- slab table starts empty, and no other seller's maintenance is due.
TRUNCATE ${["slab_publication_events", "slab_publications", "slab_publication_previews", "slab_price_overrides",
  "slab_recommendation_evidence", "slab_recommendations", "slab_comp_decisions", "slab_maintenance_items",
  "slab_maintenance_settings", "slab_supply_observations", "slab_supply_versions", "slab_supply_scans",
  "slab_evidence_revisions", "slab_evidence_refreshes", "slab_inventory", "slab_inventory_accounts",
  "slab_identities", "slab_provider_connections", "slab_seller_outcomes"].join(", ")} CASCADE;
`;
const linked: string[] = [];
for (const table of TABLES) {
  const times = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND data_type LIKE 'timestamp%'", [table])).rows.map((r) => r.column_name);
  const found = (await pool.query(`SELECT coalesce(json_agg(t ORDER BY t::text), '[]') AS rows FROM ${table} t`)).rows[0].rows as Record<string, unknown>[];
  for (const row of found) {
    for (const column of times) row[column] = fixedTime(column, row[column]);
    if ("lease_id" in row) row.lease_id = null;
  }
  // A refresh and its latest revision name each other: the revision is linked once it is saved.
  const latest = table === "slab_evidence_refreshes" ? found.map((row) => [row.key, row.latest_revision]) : [];
  for (const row of found) if (table === "slab_evidence_refreshes") row.latest_revision = null;
  seed += `INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $json$${JSON.stringify(found)}$json$);\n`;
  linked.push(...latest.filter(([, revision]) => revision).map(([key, revision]) =>
    `UPDATE slab_evidence_refreshes SET latest_revision = '${revision}' WHERE key = $key$${key}$key$;\n`));
}
seed += linked.join("");
writeFileSync(`${OUT}/cycle-seed.sql`, seed);
const recommendations = identities.slice(0, 6).filter((_, n) => n !== 3)
  .map((identity) => ({ slabId: identity.id, identityRevision: identity.revision, revisionIds: [job.runId] }));
writeFileSync(`${OUT}/cycle-recommendations.json`, JSON.stringify(recommendations, null, 1) + "\n");

// The recording, from the seed.
await pool.query(seed);
const sellerContext = { currency: "USD", currentAsk: 99, shippingCharged: 4.99, shippingCost: 4.25, acquisitionCost: 60,
  fees: { rate: 0.1325, fixed: 0.4, basis: "item-plus-shipping" }, minimumAsk: 50, minimumProfit: 10 };
for (const asked of recommendations)
  await calculateSlabRecommendation({ ...asked, policy: { ...DEFAULT_SLAB_POLICY, basis: "item-plus-shipping" }, seller: sellerContext as never }, AT);
await pool.query(readFileSync(`${OUT}/cycle-after-calculations.sql`, "utf8"));
const capture = readFileSync(`${OUT}/cycle-capture.sql`, "utf8");
const due = "UPDATE slab_maintenance_settings SET next_cycle_at=clock_timestamp(); UPDATE slab_maintenance_items SET next_check_at=clock_timestamp();";
const steps = [
  { step: "first", before: null },
  { step: "every listing due again", before: due },
  { step: "evidence expired", before: `${due} UPDATE slab_evidence_refreshes SET expires_at=clock_timestamp()-interval '1 second' WHERE state='idle';` },
  { step: "nothing due", before: null },
];
const recorded = [];
for (const { step, before } of steps) {
  if (before) await pool.query(before);
  const summary = await runSlabMaintenanceCycle();
  const saved = Object.values((await pool.query(capture)).rows[0])[0];
  recorded.push({ step, before, summary, saved });
  console.log(`${step}: ${JSON.stringify(summary)}`);
}
writeFileSync(`${OUT}/cycle.node.json`, JSON.stringify(recorded, null, 1) + "\n");
globalThis.fetch = remoteFetch;
await pool.end();
