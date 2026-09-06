import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { getPool } from "~/core/db/database.server";
import { slabIdentityStore } from "../identity/slabIdentities.server";
import { valuationGroupKey } from "../identity/slabIdentityService.server";
import {
  requestEvidence,
  claimEvidenceJob,
  completeEvidenceJob,
  cleanEvidenceCache,
} from "../evidence/evidenceRefreshStore.server";
import { saveCompDecision } from "../screening/compDecisions.server";
import { compTarget, compSale } from "../screening/screenComparables.test";
import { DEFAULT_SLAB_POLICY } from "./slabValuation";
import { sellerContext } from "./slabValuation.test";
import {
  calculateSlabRecommendation,
  getSlabRecommendation,
  overrideSlabPrice,
} from "./slabRecommendations.server";

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
const admin = new pg.Client({ connectionString: url.toString() }),
  schema = `slab_valuation_test_${randomUUID().replaceAll("-", "")}`;
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool();
const originalFetch = globalThis.fetch;
try {
  for (const name of [
    "025_add_slab_identities.sql",
    "027_add_slab_evidence_refreshes.sql",
    "030_add_slab_supply_observations.sql",
    "028_add_slab_comp_decisions.sql",
    "029_add_slab_recommendations.sql",
  ])
    await db.query(await readFile(`db/migrations/${name}`, "utf8"));
  const cert = {
    grader: compTarget.grader,
    certificateNumber: compTarget.certificateNumber,
  };
  const created = await slabIdentityStore.saveCandidate(cert, null, []);
  const target = (await slabIdentityStore.confirm(
    cert,
    created.revision,
    compTarget.identity!,
    valuationGroupKey(compTarget.identity!),
    "Fixture identity",
  ))!;
  const revisionIds: string[] = [],
    sales = [];
  for (let index = 0; index < 3; index++) {
    const sale = {
      ...compSale,
      providerId: `sale-${index}`,
      sourceItemId: `12345678901${index}`,
      date: new Date(Date.now() - index * 86400000).toISOString().slice(0, 10),
      price: { amount: 99 + index, currency: "USD" },
    };
    const spec = {
      kind: "alt-sale-detail" as const,
      transactionId: sale.providerId,
    };
    await requestEvidence([spec]);
    const job = (await claimEvidenceJob())!;
    await completeEvidenceJob(job, { kind: "alt-sale-detail", data: sale }, 1);
    revisionIds.push(job.runId);
    sales.push(sale);
  }
  globalThis.fetch = async () => {
    throw Error("Valuation must never fetch upstream");
  };
  const input = {
    slabId: target.id,
    identityRevision: target.revision,
    revisionIds,
    policy: DEFAULT_SLAB_POLICY,
    seller: sellerContext,
  };
  const asOf = new Date(Date.now() + 10).toISOString();
  const result = await calculateSlabRecommendation(input, asOf);
  assert.equal(result.calculation.market.status, "direct-evidence");
  assert.equal(result.calculation.ask.proposedItemAsk, 100);
  assert.equal(
    (await calculateSlabRecommendation(input, asOf)).id,
    result.id,
    "identical calculations are idempotent",
  );
  assert.equal((await getSlabRecommendation(result.id))?.current, true);
  await overrideSlabPrice({
    recommendationId: result.id,
    itemPrice: 105,
    currency: "USD",
    note: "Reviewed seller adjustment",
  });
  const overridden = await getSlabRecommendation(result.id);
  assert.equal(overridden?.calculation.ask.proposedItemAsk, 100);
  assert.equal(
    overridden?.override?.itemPrice,
    105,
    "override is separate from model calculation",
  );
  await saveCompDecision({
    slabId: target.id,
    identityRevision: target.revision,
    revisionId: revisionIds[0],
    provider: "alt",
    providerId: sales[0].providerId,
    date: sales[0].date,
    decision: "exclude",
    note: "Reviewed source mismatch",
  });
  assert.equal(
    (await getSlabRecommendation(result.id))?.current,
    false,
    "changed comp decisions invalidate a recommendation",
  );
  const recalculated = await calculateSlabRecommendation(
    input,
    new Date(Date.now() + 10).toISOString(),
  );
  assert.equal(recalculated.calculation.market.count, 2);
  assert.equal(recalculated.calculation.ask.proposedItemAsk, null);
  await db.query(
    "UPDATE slab_evidence_revisions SET created_at=clock_timestamp()-interval '100 days'",
  );
  await db.query(
    "UPDATE slab_evidence_refreshes SET updated_at=clock_timestamp()-interval '100 days'",
  );
  await cleanEvidenceCache();
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM slab_recommendation_evidence WHERE recommendation_id=$1",
        [result.id],
      )
    ).rowCount,
    3,
  );
  await db.query(
    "UPDATE slab_evidence_refreshes SET expires_at=clock_timestamp()-interval '1 second'",
  );
  assert.equal(
    (await getSlabRecommendation(recalculated.id))?.current,
    false,
    "expired evidence makes currency explicit",
  );
  const changed = {
    ...target.identity!,
    card: { ...target.identity!.card, language: "Spanish" },
  };
  await slabIdentityStore.confirm(
    cert,
    target.revision,
    changed,
    valuationGroupKey(changed),
    "Corrected identity",
  );
  await assert.rejects(
    overrideSlabPrice({
      recommendationId: result.id,
      itemPrice: 110,
      currency: "USD",
      note: "Stale target",
    }),
    /changed/,
  );
  await assert.rejects(calculateSlabRecommendation(input), /identity changed/);
  console.log(
    "PASS offline recommendation persistence, idempotence, separate overrides, review/identity/evidence invalidation and retained sources",
  );
} finally {
  globalThis.fetch = originalFetch;
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
