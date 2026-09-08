import assert from "node:assert/strict";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required.");
const testDatabaseName = new URL(testDatabaseUrl).pathname.replace(/^\/+/, "");
if (!testDatabaseName.startsWith("tcgplayer_strategy_test_")) {
  throw new Error("Inventory selling history tests require tcgplayer_strategy_test_*.");
}
process.env.DATABASE_URL = testDatabaseUrl;

const { execute, getPool, queryOne } = await import("../database.server");
const { inventoryPublicationsRepository } = await import(
  "./inventoryPublications.server"
);
const { inventorySellingHistoryRepository } = await import(
  "./inventorySellingHistory.server"
);
type CreateInventoryPublication = import(
  "~/features/inventory-publication/types/inventoryPublication"
).CreateInventoryPublication;

const prefix = `strategy-history-${Date.now()}`;
const sellerKey = `${prefix}-seller`;
const pricedAt = new Date("2026-07-10T12:00:00.000Z");

async function createBatchResult(
  sku: number,
  marketplacePrice: number,
  forecastDays: number,
) {
  const batch = await queryOne<{ batchNumber: number }>(
    `INSERT INTO inventory_batches (status,source_type,source_label)
    VALUES ('priced','seller',$1) RETURNING batch_number AS "batchNumber"`,
    [sellerKey],
  );
  assert.ok(batch);
  await execute(
    `INSERT INTO inventory_batch_results
      (batch_number,sku,result_status,row_json,pricing_details_json,priced_at)
    VALUES ($1,$2,'successful','{}',$3::jsonb,$4)`,
    [
      batch.batchNumber,
      sku,
      JSON.stringify({
        schemaVersion: 2,
        pricingModelVersion: "test-model-v2",
        pricedAt: pricedAt.toISOString(),
        marketplacePrice,
        policy: { method: "target-horizon", horizonDays: 30 },
        decision: {
          method: "target-horizon",
          selectedPrice: marketplacePrice,
          targetHorizonDays: 30,
          estimatedMedianSellDays: forecastDays,
          constraint: "none",
          basis: "modeled",
          forecastStatus: "interpolated",
        },
      }),
      pricedAt,
    ],
  );
  return batch.batchNumber;
}

async function createLegacyPublication(
  batchNumber: number,
  sku: number,
  desiredPrice: number,
  quantityDelta = 1,
) {
  const params: CreateInventoryPublication = {
    planningKey: `${prefix}:${sku}`,
    batchNumber,
    method: "staged_delta",
    sourceType: "seller",
    sellerKey,
    items: [{
      candidateKey: `pricing-result:${batchNumber}:${sku}:${pricedAt.toISOString()}`,
      inventoryDeltaKey: quantityDelta === 0 ? null : `${prefix}:delta:${sku}`,
      batchNumber,
      sku,
      productId: sku,
      productLine: "Pokemon",
      setName: "Test",
      productName: `Card ${sku}`,
      condition: "Near Mint",
      desiredPrice,
      quantityDelta,
      pricedAt,
    }],
  };
  const result = await inventoryPublicationsRepository.createOrFindPlanned(params);
  const publicationId = result.publication.id;
  const itemId = result.publication.items[0].id;
  await execute(
    `UPDATE inventory_publications SET status='publishing' WHERE id=$1`,
    [publicationId],
  );
  await inventoryPublicationsRepository.saveItemOutcomes(publicationId, [
    { itemId, status: "published", confirmedAt: pricedAt },
  ]);
  return { publicationId, itemId, params };
}

try {
  const exactBatch = await createBatchResult(9_640_101, 24.99, 28);
  const exact = await createLegacyPublication(exactBatch, 9_640_101, 24.99);
  const mismatchBatch = await createBatchResult(9_640_102, 12.5, 45);
  const mismatch = await createLegacyPublication(mismatchBatch, 9_640_102, 12.51);
  const repricingBatch = await createBatchResult(9_640_103, 9.99, 18);
  const repricing = await createLegacyPublication(
    repricingBatch,
    9_640_103,
    9.99,
    0,
  );

  assert.equal(
    await inventoryPublicationsRepository.backfillSupportedForecastEvidence(
      `${sellerKey}-other`,
      1,
    ),
    0,
  );
  assert.equal(await inventoryPublicationsRepository.backfillSupportedForecastEvidence(sellerKey, 1), 1);
  assert.equal(await inventoryPublicationsRepository.backfillSupportedForecastEvidence(sellerKey, 1), 0);
  const exactItem = (await inventoryPublicationsRepository.findById(exact.publicationId))!.items[0];
  assert.equal(exactItem.forecastEvidenceProvenance, "recorded");
  assert.equal(exactItem.forecastEvidence?.source, "historical_pricing_result_exact_match");
  assert.equal(exactItem.forecastEvidence?.decision?.estimatedMedianSellDays, 28);
  assert.equal(
    (await inventoryPublicationsRepository.createOrFindPlanned(exact.params)).created,
    false,
    "an omitted legacy forecast remains the request identity after backfill",
  );
  await assert.rejects(
    inventoryPublicationsRepository.createOrFindPlanned({
      ...exact.params,
      items: exact.params.items.map((item) => ({
        ...item,
        forecastEvidence: {
          source: "publication_candidate" as const,
          schemaVersion: 2,
          pricedAt: pricedAt.toISOString(),
          pricingModelVersion: "different-supplied-model",
        },
      })),
    }),
    /different planning inputs/,
  );
  const mismatchItem = (await inventoryPublicationsRepository.findById(mismatch.publicationId))!.items[0];
  assert.equal(mismatchItem.forecastEvidence, null);
  assert.equal(mismatchItem.forecastEvidenceProvenance, "unknown");
  const repricingItem = (await inventoryPublicationsRepository.findById(repricing.publicationId))!.items[0];
  assert.equal(repricingItem.forecastEvidence, null);

  await execute(
    `UPDATE inventory_batch_results SET pricing_details_json=jsonb_set(
      pricing_details_json,'{decision,estimatedMedianSellDays}','3'::jsonb)
    WHERE batch_number=$1 AND sku=$2`,
    [exactBatch, 9_640_101],
  );
  assert.equal(await inventoryPublicationsRepository.backfillSupportedForecastEvidence(sellerKey, 10), 0);
  const immutable = (await inventoryPublicationsRepository.findById(exact.publicationId))!.items[0];
  assert.equal(immutable.forecastEvidence?.decision?.estimatedMedianSellDays, 28);
  await assert.rejects(
    inventoryPublicationsRepository.backfillSupportedForecastEvidence(sellerKey, 0),
    /limit must be between 1 and 1000/,
  );
  await execute(
    `INSERT INTO inventory_fifo_replay_queue
      (seller_key,sku,affected_from,status,generation,hold_reason)
    VALUES
      ($1,9640201,$2,'held',1,'unexplained_inventory_difference:1:observed_-1:expected_-1'),
      ($1,9640202,$2,'held',1,'unexplained_inventory_difference:2:observed_-2:expected_-1')`,
    [sellerKey, pricedAt],
  );
  const historyEvidence = await inventorySellingHistoryRepository.findEvidence(
    sellerKey,
    { windowDays: 180, productLine: null },
  );
  assert.equal(historyEvidence.unresolvedRemoval.quantity, 1);
  assert.deepEqual(historyEvidence.unresolvedRemoval.affectedSkus, [9_640_202]);
  console.log("PASS publication forecast backfill is exact, bounded, and immutable");
} finally {
  await getPool().end();
}
