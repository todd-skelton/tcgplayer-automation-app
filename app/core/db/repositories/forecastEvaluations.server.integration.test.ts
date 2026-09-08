import assert from "node:assert/strict";
import { getDatabaseUrl, getPool } from "../database.server";
import { pricingConfigRepository } from "./pricingConfig.server";
import { inventoryPublicationSettingsRepository } from "./inventoryPublicationSettings.server";
import { forecastEvaluationsRepository } from "./forecastEvaluations.server";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { evaluateForecastEvidence, type ForecastEvaluationEvidence } from "~/features/pricing/domain/forecastEvaluation";
import { toPricingCurve } from "~/features/pricing/domain/pricingPolicy";

const databaseName = new URL(getDatabaseUrl()).pathname.slice(1);
if (!/^tcgplayer_(?:automation|strategy)_test_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error(`Forecast evaluation integration test requires an isolated test database, received ${databaseName}.`);
}
const pool = getPool();
const seller = `synthetic-author65-${Date.now()}`;
const otherSeller = `${seller}-other`;
const gapSeller = `${seller}-gap`;
const bridgeSeller = `${seller}-bridge`;
const exposureSeller = `${seller}-exposure`;
const now = Date.now();
const DAY = 86_400_000;
const iso = (daysBefore: number) => new Date(now - daysBefore * DAY).toISOString();
const originalConfig = await pricingConfigRepository.get();
const originalPublicationSettings = await inventoryPublicationSettingsRepository.get();

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
    orderHistory: { runId: "synthetic-run", status: "complete", coveredFrom: iso(365), coveredThrough: iso(0), cutoffAt: iso(0), gaps: [] },
    spells, orderRevisions: [],
    exposure: spells.flatMap((spell) => Array.from({ length: 4 }, (_, index) => ({
      observationId: `${spell.publicationItemId}:${index}`, publicationItemId: spell.publicationItemId, sku: spell.sku,
      observedAt: new Date(Date.parse(spell.publishedAt!) + (index + 1) * 6 * DAY).toISOString(), quantity: 1,
    }))),
    fifo: spells.map((spell) => ({ sku: spell.sku, state: "settled", revisionIds: [`fifo:${spell.sku}`], latestRecordedAt: iso(1) })),
  };
}

try {
  await pool.query(
    `INSERT INTO seller_order_sync_runs
      (seller_key,source,status,search_range,started_at,finished_at,observed_from,observed_through,gaps,updated_at)
     VALUES
      ($1,'tcgplayer_api','complete','historical','2026-08-01','2026-08-01','2026-01-01','2026-03-01','[]','2026-08-01'),
      ($1,'tcgplayer_api','complete','recent','2026-09-02','2026-09-02','2026-06-01','2026-09-01','[]','2026-09-02'),
      ($2,'tcgplayer_api','complete','historical','2026-08-01','2026-08-01','2026-01-01','2026-03-01','[]','2026-08-01'),
      ($2,'tcgplayer_api','complete','bridge','2026-08-15','2026-08-15','2026-03-01','2026-06-01','[]','2026-08-15'),
      ($2,'tcgplayer_api','complete','recent','2026-09-02','2026-09-02','2026-06-01','2026-09-01','[]','2026-09-02')`,
    [gapSeller, bridgeSeller],
  );
  const gapCoverage = (await forecastEvaluationsRepository.findEvidence(gapSeller)).orderHistory;
  assert.equal(gapCoverage.coveredFrom, "2026-06-01T00:00:00.000Z",
    "disconnected observed intervals do not bridge through ingestion time");
  assert.equal(gapCoverage.cutoffAt, "2026-09-01T00:00:00.000Z",
    "the order-history cutoff uses the exact observed-through boundary");
  assert.equal((await forecastEvaluationsRepository.findEvidence(bridgeSeller)).orderHistory.coveredFrom,
    "2026-01-01T00:00:00.000Z", "touching observed intervals retain their continuous union");
  const exposurePublicationAt = new Date(now - 150 * DAY);
  const exposureSku = 765_001;
  const zeroExposureSku = exposureSku + 1;
  const repricedExposureSku = exposureSku + 2;
  const exposurePublication = await pool.query<{ id: string }>(
    `INSERT INTO inventory_publications
      (planning_key,method,source_type,seller_key,status,published_at,completed_at)
     VALUES($1,'direct_absolute','continuous',$1,'published',$2,$2) RETURNING id::text AS id`,
    [exposureSeller, exposurePublicationAt],
  );
  await pool.query(
    `INSERT INTO inventory_publication_items
      (publication_id,candidate_key,sku,product_id,product_line,set_name,product_name,
       condition,desired_price,desired_absolute_quantity,priced_at,status,published_at,
       forecast_evidence,forecast_evidence_provenance)
     VALUES
      ($1,$2||'-positive',$3,$3,'Synthetic','Set','Retained exposure','Near Mint',5,1,$4,
       'published',$4,$5::jsonb,'recorded'),
      ($1,$2||'-zero',$3+1,$3+1,'Synthetic','Set','Known zero exposure','Near Mint',5,1,$4,
       'published',$4,$5::jsonb,'recorded'),
      ($1,$2||'-repriced',$3+2,$3+2,'Synthetic','Set','Retained through repricing','Near Mint',5,1,$4,
       'published',$4,$5::jsonb,'recorded')`,
    [exposurePublication.rows[0]!.id, exposureSeller, exposureSku, exposurePublicationAt,
      JSON.stringify({ source: "publication_candidate", pricedAt: exposurePublicationAt.toISOString(),
        pricingModelVersion: "pooled-supply-v1",
        decision: { basis: "modeled", method: "profit-per-day", selectedPrice: 5, estimatedMedianSellDays: 14 } })],
  );
  const repricingPublication = await pool.query<{ id: string }>(
    `INSERT INTO inventory_publications
      (planning_key,method,source_type,seller_key,status,published_at,completed_at)
     VALUES($1||'-repricing','direct_absolute','continuous',$1,'published',
       $2::timestamptz+INTERVAL '35 days',$2::timestamptz+INTERVAL '35 days')
     RETURNING id::text AS id`, [exposureSeller, exposurePublicationAt],
  );
  await pool.query(
    `INSERT INTO inventory_publication_items
      (publication_id,candidate_key,sku,product_id,product_line,set_name,product_name,condition,
       desired_price,quantity_delta,priced_at,status,published_at,forecast_evidence_provenance)
     VALUES($1,$2||'-price-only',$3,$3,'Synthetic','Set','Retained through repricing','Near Mint',
       4.5,0,$4::timestamptz+INTERVAL '35 days','published',
       $4::timestamptz+INTERVAL '35 days','unknown')`,
    [repricingPublication.rows[0]!.id, exposureSeller, repricedExposureSku, exposurePublicationAt],
  );
  await pool.query(
    `INSERT INTO inventory_complete_observations
      (request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,quantity_fingerprint,
       supported_quantity_fingerprint,first_content_fingerprint,second_content_fingerprint,item_count,
       positive_item_count,total_quantity,supported_positive_sku_count,supported_total_quantity,
       unsupported_positive_item_count,unsupported_positive_quantity,identity_evidence)
     SELECT $1||'-'||week,$1,'seller_portal_live_export','complete','sellable_excludes_reserved',
       $2::timestamptz+(week*INTERVAL '7 days')-INTERVAL '1 second',
       $2::timestamptz+(week*INTERVAL '7 days'),
       'quantity','supported','first','second',3,2,2,2,2,0,0,'{}'::jsonb
     FROM generate_series(1,20) week RETURNING id::text AS id`,
    [exposureSeller, exposurePublicationAt],
  );
  await pool.query(
    `INSERT INTO inventory_complete_observation_items
      (observation_id,inventory_key,identity_kind,sku,quantity)
     SELECT observation.id,value.sku::text,'standard_sku',value.sku,value.quantity
     FROM inventory_complete_observations observation
     CROSS JOIN (VALUES($1::int,1),($1::int+1,0),($1::int+2,1)) value(sku,quantity)
     WHERE observation.seller_key=$2`, [exposureSku, exposureSeller],
  );
  await pool.query(
    `DELETE FROM inventory_complete_observation_items item USING inventory_complete_observations observation
     WHERE observation.id=item.observation_id AND observation.seller_key=$1
       AND observation.cutoff_at < (SELECT MAX(cutoff_at)-INTERVAL '14 days'
         FROM inventory_complete_observations WHERE seller_key=$1)`, [exposureSeller],
  );
  await pool.query(
    `INSERT INTO seller_order_sync_runs
      (seller_key,source,status,search_range,started_at,finished_at,observed_from,observed_through,gaps,updated_at)
     VALUES($1,'tcgplayer_api','complete','all',$2::timestamptz,NOW(),
       $2::timestamptz-INTERVAL '1 day',NOW(),'[]',NOW())`,
    [exposureSeller, exposurePublicationAt],
  );
  const retainedExposure = evaluateForecastEvidence(
    await forecastEvaluationsRepository.findEvidence(exposureSeller),
  );
  assert.equal(retainedExposure.observations.find((value) => value.sku === exposureSku)?.sold, false,
    "months of payload pruning do not erase a continuously observed unsold outcome without an opening run");
  assert.equal(retainedExposure.observations.find((value) => value.sku === repricedExposureSku)?.sold, false,
    "a later price-only publication does not erase the completed earlier exposure interval");
  assert.equal(retainedExposure.observations.some((value) => value.sku === zeroExposureSku), false);
  assert.equal(retainedExposure.coverage.exclusions.stock_removed?.spells, 1,
    "a retained zero state back-decodes the first observed header as removed");
  await inventoryPublicationSettingsRepository.save({
    ...originalPublicationSettings.settings,
    continuousPricing: {
      ...originalPublicationSettings.settings.continuousPricing,
      sellerKey: seller,
    },
  });
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
  const concurrentReport = structuredClone(report);
  concurrentReport.evidenceFingerprint = "9".repeat(64);
  concurrentReport.evaluatedAt = iso(1);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () =>
    forecastEvaluationsRepository.save(concurrentReport)));
  assert.equal(new Set(concurrent.map((value) => value.id)).size, 1);
  assert.equal(concurrent.filter((value) => value.created).length, 1,
    "concurrent identical saves persist one immutable row without unique-key failures");

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
  await pool.query(`DROP TRIGGER IF EXISTS forecast_evaluation_test_slow_insert ON forecast_evaluations`);
  await pool.query(`CREATE OR REPLACE FUNCTION forecast_evaluation_test_slow_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END$$`);
  await pool.query(`CREATE TRIGGER forecast_evaluation_test_slow_insert
    BEFORE INSERT ON forecast_evaluations FOR EACH ROW
    EXECUTE FUNCTION forecast_evaluation_test_slow_insert()`);
  try {
    const overlappingReport = structuredClone(report);
    overlappingReport.evidenceFingerprint = "7".repeat(64);
    overlappingReport.evaluatedAt = iso(3);
    const saving = forecastEvaluationsRepository.save(overlappingReport);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rollingBack = forecastEvaluationsRepository.rollback({
      sellerKey: seller,
      correctionVersion: report.correction!.version,
      reason: "concurrent regression",
    });
    const overlap = await Promise.allSettled([saving, rollingBack]);
    assert.ok(overlap.every((value) => value.status === "fulfilled"),
      "save and rollback share one lock order without deadlocking");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS forecast_evaluation_test_slow_insert ON forecast_evaluations`);
    await pool.query(`DROP FUNCTION IF EXISTS forecast_evaluation_test_slow_insert()`);
  }
  await forecastEvaluationsRepository.activate({
    sellerKey: seller, evaluationId: first.id, sourceModelVersion: "curve:pooled-supply-v1", now: new Date(now),
  });
  const outOfOrder = structuredClone(report);
  outOfOrder.evidenceFingerprint = "8".repeat(64);
  outOfOrder.evaluatedAt = iso(2);
  await forecastEvaluationsRepository.save(outOfOrder);
  assert.equal((await pricingConfigRepository.get()).pricing.forecastCorrection?.evaluationId, first.id,
    "an older report cannot reverse the latest evaluation or rebind its active correction");
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
    /not active|another seller/,
  );
  await inventoryPublicationSettingsRepository.save({
    ...originalPublicationSettings.settings,
    continuousPricing: {
      ...originalPublicationSettings.settings.continuousPricing,
      sellerKey: otherSeller,
    },
  });
  assert.equal((await pricingConfigRepository.get()).pricing.forecastCorrection, null,
    "switching the configured seller invalidates the previous seller's correction");
  await inventoryPublicationSettingsRepository.save({
    ...originalPublicationSettings.settings,
    continuousPricing: {
      ...originalPublicationSettings.settings.continuousPricing,
      sellerKey: seller,
    },
  });
  await forecastEvaluationsRepository.activate({
    sellerKey: seller, evaluationId: first.id, sourceModelVersion: "curve:pooled-supply-v1", now: new Date(now),
  });
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
  const queuedCorrection = (await pricingConfigRepository.get()).pricing.forecastCorrection!;
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
  assert.equal(await forecastEvaluationsRepository.isCorrectionSupported(queuedCorrection), false,
    "an explicitly rolled-back queued correction snapshot cannot remain supported");
} finally {
  await inventoryPublicationSettingsRepository.save(originalPublicationSettings.settings);
  await pricingConfigRepository.save(originalConfig);
  await pool.query(`DELETE FROM forecast_correction_events WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM forecast_evaluations WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_publication_items WHERE candidate_key=$1`, [`forecast-material-item-${seller}`]);
  await pool.query(`DELETE FROM inventory_publications WHERE planning_key=$1`, [`forecast-material-${seller}`]);
  await pool.query(`DELETE FROM seller_order_sync_runs WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM forecast_correction_events WHERE seller_key=$1`, [otherSeller]);
  await pool.query(`DELETE FROM forecast_evaluations WHERE seller_key=$1`, [otherSeller]);
  await pool.query(`DELETE FROM seller_order_sync_runs WHERE seller_key=ANY($1::text[])`, [[gapSeller, bridgeSeller]]);
  await pool.query(`DELETE FROM seller_order_sync_runs WHERE seller_key=$1`, [exposureSeller]);
  await pool.query(`DELETE FROM inventory_complete_observation_items WHERE observation_id IN
    (SELECT id FROM inventory_complete_observations WHERE seller_key=$1)`, [exposureSeller]);
  await pool.query(`DELETE FROM inventory_complete_observations WHERE seller_key=$1`, [exposureSeller]);
  await pool.query(`DELETE FROM inventory_publication_items WHERE publication_id IN
    (SELECT id FROM inventory_publications WHERE seller_key=$1)`, [exposureSeller]);
  await pool.query(`DELETE FROM inventory_publications WHERE seller_key=$1`, [exposureSeller]);
}

await pool.end();
console.log("PASS forecast evaluation persistence activates, preserves policy, and falls back after superseding evidence");
