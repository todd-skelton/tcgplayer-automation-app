import assert from "node:assert/strict";
import { getDatabaseUrl, getPool } from "../database.server";
import { pricingConfigRepository } from "./pricingConfig.server";
import { forecastEvaluationsRepository } from "./forecastEvaluations.server";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { evaluateForecastEvidence, type ForecastEvaluationEvidence } from "~/features/pricing/domain/forecastEvaluation";
import { toPricingCurve } from "~/features/pricing/domain/pricingPolicy";

const databaseName = new URL(getDatabaseUrl()).pathname.slice(1);
if (!databaseName.includes("author65")) {
  throw new Error(`Forecast evaluation integration test requires an author65 database, received ${databaseName}.`);
}
const pool = getPool();
const seller = `synthetic-author65-${Date.now()}`;
const otherSeller = `${seller}-other`;
const now = Date.now();
const DAY = 86_400_000;
const iso = (daysBefore: number) => new Date(now - daysBefore * DAY).toISOString();
const originalConfig = await pricingConfigRepository.get();

function eligibleEvidence(): ForecastEvaluationEvidence {
  const spells = Array.from({ length: 100 }, (_, index) => {
    const daysBefore = index < 50
      ? 200 - index
      : index < 80
        ? 100 - (index - 50)
        : 20 - (index - 80) * 0.5;
    return {
      publicationItemId: String(index + 1), sellerKey: seller, sku: 100_000 + index,
      productLine: "Synthetic", productLineId: 1, publishedAt: iso(daysBefore), nextPublishedAt: null,
      desiredPrice: 5, quantity: 1,
      forecastEvidenceProvenance: "recorded" as const,
      forecastEvidence: {
        source: "publication_candidate", pricedAt: iso(daysBefore), pricingModelVersion: "pooled-supply-v1",
        decision: { basis: "modeled", method: "profit-per-day", selectedPrice: 5, estimatedMedianSellDays: 7 },
      },
    };
  });
  return {
    sellerKey: seller, evaluatedAt: new Date(now).toISOString(),
    orderHistory: { runId: "synthetic-run", status: "complete", coveredFrom: iso(365), cutoffAt: new Date(now).toISOString(), gaps: [] },
    spells, orderRevisions: [],
    exposure: spells.flatMap((spell) => Array.from({ length: 4 }, (_, index) => ({
      observationId: `${spell.publicationItemId}:${index}`, sku: spell.sku,
      observedAt: new Date(Date.parse(spell.publishedAt!) + (index + 1) * 6 * DAY).toISOString(), quantity: 1,
    }))),
    fifo: spells.map((spell) => ({ sku: spell.sku, state: "settled", revisionIds: [`fifo:${spell.sku}`], latestRecordedAt: iso(1) })),
  };
}

try {
  await pricingConfigRepository.save({
    ...DEFAULT_SERVER_PRICING_CONFIG,
    pricing: { ...DEFAULT_SERVER_PRICING_CONFIG.pricing, minPriceConstant: 1.23 },
  });
  const report = evaluateForecastEvidence(eligibleEvidence());
  report.materialEvidenceVersion = await forecastEvaluationsRepository.findMaterialEvidenceVersion(seller);
  assert.equal(report.status, "eligible");
  const first = await forecastEvaluationsRepository.save(report);
  const repeated = await forecastEvaluationsRepository.save(report);
  assert.equal(first.created, true);
  assert.deepEqual(repeated, { id: first.id, created: false }, "same frozen policy and evidence is idempotent");

  await assert.rejects(
    forecastEvaluationsRepository.activate({ sellerKey: seller, evaluationId: first.id, sourceModelVersion: "wrong-model" }),
    /requires curve:pooled-supply-v1/,
  );
  await forecastEvaluationsRepository.activate({
    sellerKey: seller, evaluationId: first.id, sourceModelVersion: "curve:pooled-supply-v1", now: new Date(now),
  });
  const active = await pricingConfigRepository.get();
  assert.equal(active.pricing.minPriceConstant, 1.23, "activation preserves unrelated pricing settings");
  assert.equal(active.pricing.forecastCorrection?.evaluationId, first.id);
  assert.equal(active.pricing.forecastCorrection?.productLineMedianDaysMultipliers?.[1], 1.25);
  await pool.query(
    `INSERT INTO seller_order_sync_runs
      (seller_key,source,status,started_at,finished_at,observed_from,observed_through,gaps,updated_at)
     VALUES($1,'tcgplayer_api','complete',NOW(),NOW(),NOW()-INTERVAL '90 days',NOW(),'[]'::jsonb,NOW())`,
    [seller],
  );
  assert.equal(
    (await pricingConfigRepository.get()).pricing.forecastCorrection?.evaluationId,
    first.id,
    "an unrelated complete-scan heartbeat does not invalidate supported material evidence",
  );
  const otherFirst = structuredClone(report);
  otherFirst.sellerKey = otherSeller;
  otherFirst.evidenceFingerprint = "d".repeat(64);
  otherFirst.materialEvidenceVersion = await forecastEvaluationsRepository.findMaterialEvidenceVersion(otherSeller);
  await forecastEvaluationsRepository.save(otherFirst);
  const otherSecond = structuredClone(otherFirst);
  otherSecond.evidenceFingerprint = "e".repeat(64);
  await forecastEvaluationsRepository.save(otherSecond);
  assert.equal((await pricingConfigRepository.get()).pricing.forecastCorrection?.evaluationId, first.id,
    "another seller cannot rebind the global active correction");
  await assert.rejects(
    forecastEvaluationsRepository.rollback({ sellerKey: otherSeller, correctionVersion: report.correction!.version, reason: "wrong owner" }),
    /belongs to another seller/,
  );
  const rawCurve = toPricingCurve([{ percentile: 50, suggestedPrice: 5, historicalSalesVelocityDays: 10, storeWinShare: 0.5 }]);
  const correctedCurve = toPricingCurve(
    [{ percentile: 50, suggestedPrice: 5, historicalSalesVelocityDays: 10, storeWinShare: 0.5 }],
    active.pricing.forecastCorrection ?? undefined,
  );
  assert.equal(correctedCurve[0]!.estimatedMedianSellDays, rawCurve[0]!.estimatedMedianSellDays! * 1.25);

  const superseding = structuredClone(report);
  superseding.evidenceFingerprint = "b".repeat(64);
  superseding.status = "abstained";
  superseding.statusReasons = ["late_correction_removed_support"];
  superseding.correction!.eligible = false;
  superseding.correction!.reasons = ["held_out_brier_improvement_below_minimum"];
  const second = await forecastEvaluationsRepository.save(superseding);
  assert.equal(second.created, true);
  assert.equal((await pricingConfigRepository.get()).pricing.forecastCorrection, null);
  await assert.rejects(
    forecastEvaluationsRepository.activate({ sellerKey: seller, evaluationId: first.id, sourceModelVersion: "curve:pooled-supply-v1", now: new Date(now) }),
    /stale/,
  );

  const renewed = structuredClone(report);
  renewed.evidenceFingerprint = "c".repeat(64);
  const third = await forecastEvaluationsRepository.save(renewed);
  await forecastEvaluationsRepository.activate({ sellerKey: seller, evaluationId: third.id, sourceModelVersion: "curve:pooled-supply-v1", now: new Date(now) });
  await pool.query(
    `UPDATE pricing_config SET pricing_json=jsonb_set(pricing_json,
      '{forecastCorrection,productLineMedianDaysMultipliers,1}','9'::jsonb) WHERE config_key='default'`,
  );
  assert.equal((await pricingConfigRepository.get()).pricing.forecastCorrection, null, "a tampered line correction falls back on the pricing read path");

  const materialChange = await pool.query<{ id: string }>(
    `INSERT INTO inventory_publications
      (planning_key,method,source_type,seller_key,status,published_at,completed_at)
     VALUES($1,'direct_absolute','seller',$2,'published',NOW(),NOW()) RETURNING id::text AS id`,
    [`forecast-material-${seller}`, seller],
  );
  await pool.query(
    `INSERT INTO inventory_publication_items
      (publication_id,candidate_key,sku,product_id,product_line,set_name,product_name,condition,
       desired_price,quantity_delta,priced_at,status,published_at,forecast_evidence,forecast_evidence_provenance)
     VALUES($1,$2,999999,1,'Synthetic','Synthetic','Synthetic','Near Mint',5,0,NOW(),'published',NOW(),
       '{"source":"publication_candidate","pricedAt":"2026-01-01T00:00:00.000Z"}'::jsonb,'recorded')`,
    [materialChange.rows[0]!.id, `forecast-material-item-${seller}`],
  );
  await assert.rejects(
    forecastEvaluationsRepository.activate({ sellerKey: seller, evaluationId: third.id, sourceModelVersion: "curve:pooled-supply-v1", now: new Date(now) }),
    /evidence has changed/,
  );
  const refreshed = structuredClone(report);
  refreshed.evidenceFingerprint = renewed.evidenceFingerprint;
  refreshed.materialEvidenceVersion = await forecastEvaluationsRepository.findMaterialEvidenceVersion(seller);
  const fourth = await forecastEvaluationsRepository.save(refreshed);
  await forecastEvaluationsRepository.activate({ sellerKey: seller, evaluationId: fourth.id, sourceModelVersion: "curve:pooled-supply-v1", now: new Date(now) });
  await assert.rejects(
    forecastEvaluationsRepository.rollback({ sellerKey: seller, correctionVersion: "wrong-version", reason: "synthetic check" }),
    /not active/,
  );
  await forecastEvaluationsRepository.rollback({
    sellerKey: seller,
    correctionVersion: renewed.correction!.version,
    reason: "synthetic operator rollback",
  });
  assert.equal((await pricingConfigRepository.get()).pricing.forecastCorrection, null);
} finally {
  await pricingConfigRepository.save(originalConfig);
  await pool.query(`DELETE FROM forecast_correction_events WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM forecast_evaluations WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_publication_items WHERE candidate_key=$1`, [`forecast-material-item-${seller}`]);
  await pool.query(`DELETE FROM inventory_publications WHERE planning_key=$1`, [`forecast-material-${seller}`]);
  await pool.query(`DELETE FROM seller_order_sync_runs WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM forecast_correction_events WHERE seller_key=$1`, [otherSeller]);
  await pool.query(`DELETE FROM forecast_evaluations WHERE seller_key=$1`, [otherSeller]);
}

console.log("PASS forecast evaluation persistence activates, preserves policy, and falls back after superseding evidence");
