import assert from "node:assert/strict";
import { execute, getPool, query, queryOne } from "../database.server";
import { inventoryBatchesRepository } from "./inventoryBatches.server";
import { pendingInventoryRepository } from "./pendingInventory.server";
import { inventoryPublicationsRepository } from "./inventoryPublications.server";
import { action as publicationAction } from "~/features/pending-inventory/routes/api.inventory-batch-publications";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for this integration test.");
}
const testDatabaseName = new URL(testDatabaseUrl).pathname.replace(/^\/+/, "");
if (!testDatabaseName.startsWith("tcgplayer_fifo_test_")) {
  throw new Error(
    "TEST_DATABASE_URL must name a disposable tcgplayer_fifo_test_* database.",
  );
}
process.env.DATABASE_URL = testDatabaseUrl;

const prefix = `publication-receipts-${Date.now()}`;
const sellerKey = `${prefix}-seller`;
const skuA = 9_200_001;
const skuB = 9_200_002;
const metadata = { productLineId: 1, setId: 2, productId: 3 };
const unavailableMarket = {
  marketValue: null,
  observedAt: null,
  calculatedAt: null,
  provenance: "tcgplayer_price_points_unavailable" as const,
};

async function addReceipt(sku: number, quantity: number, suffix: string) {
  await pendingInventoryRepository.mutate({
    type: "add",
    requestId: `${prefix}-${suffix}`,
    sku,
    quantity,
    metadata,
    intakeAt: new Date("2026-08-01T12:00:00.000Z"),
    market: unavailableMarket,
  });
}

function publicationItem(
  batchNumber: number,
  sku: number,
  quantity: number,
) {
  return {
    candidateKey: `${prefix}-candidate-${batchNumber}-${sku}`,
    inventoryDeltaKey: `${prefix}-delta-${batchNumber}-${sku}`,
    batchNumber,
    sku,
    productId: metadata.productId,
    productLine: "Pokemon",
    setName: "Test Set",
    productName: `Card ${sku}`,
    condition: "Near Mint",
    desiredPrice: 4.25,
    quantityDelta: quantity,
    pricedAt: new Date("2026-08-10T11:00:00.000Z"),
    forecastEvidence: {
      source: "publication_candidate" as const,
      schemaVersion: 2,
      pricingModelVersion: "integration-model-v2",
      pricedAt: "2026-08-10T11:00:00.000Z",
      decision: {
        method: "target-horizon" as const,
        selectedPrice: 4.25,
        targetHorizonDays: 30,
        estimatedMedianSellDays: 24,
        constraint: "none" as const,
        basis: "modeled" as const,
        forecastStatus: "interpolated" as const,
      },
    },
  };
}

try {
  await addReceipt(skuA, 2, "aa");
  await addReceipt(skuA, 3, "bbb");
  await addReceipt(skuB, 4, "cccc");
  const batch = await inventoryBatchesRepository.createFromPendingInventory(
    `${prefix}-batch`,
  );
  assert.ok(batch);

  const params = {
    planningKey: `${prefix}-plan`,
    batchNumber: batch.batchNumber,
    method: "staged_delta" as const,
    sourceType: "pending_inventory" as const,
    sellerKey: ` ${sellerKey} `,
    items: [
      publicationItem(batch.batchNumber, skuA, 5),
      publicationItem(batch.batchNumber, skuB, 4),
    ],
  };
  const planned = await inventoryPublicationsRepository.createOrFindPlanned(params);
  const repeated = await inventoryPublicationsRepository.createOrFindPlanned(params);
  assert.equal(repeated.created, false);
  assert.equal(repeated.publication.sellerKey, sellerKey);
  assert.equal(
    repeated.publication.items[0].forecastEvidence?.decision?.estimatedMedianSellDays,
    24,
  );
  await assert.rejects(
    inventoryPublicationsRepository.createOrFindPlanned({
      ...params,
      items: [{ ...params.items[0], desiredPrice: 5 }, params.items[1]],
    }),
    /different planning inputs/,
  );

  const publicationId = Number(planned.publication.id);
  const itemA = Number(planned.publication.items.find((item) => item.sku === skuA)?.id);
  const itemB = Number(planned.publication.items.find((item) => item.sku === skuB)?.id);
  const plannedLinks = await query<{ sku: number; quantity: number; liveAt: Date | null }>(
    `SELECT receipt.sku, SUM(link.planned_quantity)::int AS quantity,
      MAX(link.live_at) AS "liveAt"
    FROM inventory_publication_receipt_links link
    JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
    WHERE link.publication_item_id = ANY($1::bigint[])
    GROUP BY receipt.sku ORDER BY receipt.sku`,
    [[itemA, itemB]],
  );
  assert.deepEqual(
    plannedLinks.map((row) => ({ sku: row.sku, quantity: row.quantity, liveAt: row.liveAt })),
    [
      { sku: skuA, quantity: 5, liveAt: null },
      { sku: skuB, quantity: 4, liveAt: null },
    ],
  );

  await execute(
    `UPDATE inventory_publications SET status = 'publishing' WHERE id = $1`,
    [publicationId],
  );
  await execute(`CREATE FUNCTION ${prefix.replaceAll("-", "_")}_fail_activation()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected activation failure';
    END $$`);
  await execute(`CREATE TRIGGER fail_activation
    BEFORE UPDATE ON inventory_publication_receipt_links
    FOR EACH ROW EXECUTE FUNCTION ${prefix.replaceAll("-", "_")}_fail_activation()`);

  const confirmedAtA = new Date("2026-08-10T12:00:00.000Z");
  const outcomes = [
    {
      itemId: itemA,
      status: "published" as const,
      confirmedAt: confirmedAtA,
      confirmationEvidence: { source: "test-response", responseId: "one" },
    },
    {
      itemId: itemB,
      status: "ambiguous" as const,
      errorCode: "seller_portal_item_warning",
      errorMessage: "confirmation required",
    },
  ];
  await assert.rejects(
    inventoryPublicationsRepository.saveItemOutcomes(publicationId, outcomes),
    /injected activation failure/,
  );
  assert.deepEqual(
    planned.publication.items.map((item) => item.status),
    ["planned", "planned"],
  );
  const unchanged = await inventoryPublicationsRepository.findById(publicationId);
  assert.deepEqual(unchanged?.items.map((item) => item.status), ["planned", "planned"]);

  await execute(`DROP TRIGGER fail_activation ON inventory_publication_receipt_links`);
  await execute(`DROP FUNCTION ${prefix.replaceAll("-", "_")}_fail_activation()`);
  await inventoryPublicationsRepository.saveItemOutcomes(publicationId, outcomes);
  await execute(
    `UPDATE inventory_publications SET status = 'ambiguous' WHERE id = $1`,
    [publicationId],
  );

  let activation = await query<{
    sku: number;
    quantity: number;
    liveAt: Date | null;
    sellerKey: string | null;
  }>(
    `SELECT receipt.sku, SUM(link.planned_quantity)::int AS quantity,
      MAX(link.live_at) AS "liveAt", MIN(receipt.seller_key) AS "sellerKey"
    FROM inventory_publication_receipt_links link
    JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
    WHERE link.publication_item_id = ANY($1::bigint[])
      AND link.live_at IS NOT NULL
    GROUP BY receipt.sku ORDER BY receipt.sku`,
    [[itemA, itemB]],
  );
  assert.deepEqual(
    activation.map((row) => ({
      sku: row.sku,
      quantity: row.quantity,
      liveAt: row.liveAt?.toISOString(),
      sellerKey: row.sellerKey,
    })),
    [{ sku: skuA, quantity: 5, liveAt: confirmedAtA.toISOString(), sellerKey }],
  );

  const confirmedAtB = new Date("2026-08-10T12:05:00.000Z");
  const correctionResponse = await publicationAction({
    params: { batchNumber: String(batch.batchNumber) },
    request: new Request(
      `http://localhost/api/inventory-batches/${batch.batchNumber}/publications`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "confirm-ambiguous-item",
          publicationId,
          itemId: itemB,
          confirmedQuantity: 4,
          sellerKey,
          confirmedAt: confirmedAtB.toISOString(),
          evidence: { source: "operator-confirmation", ticket: "T-1" },
        }),
      },
    ),
  });
  assert.equal(correctionResponse.init?.status, 200);
  const correctedPublication = correctionResponse.data as {
    id: number;
    status: string;
    items: Array<{ id: number }>;
  };
  assert.equal(typeof correctedPublication.id, "number");
  assert.equal(typeof correctedPublication.items[0]?.id, "number");
  assert.equal(correctedPublication.status, "published");
  const repeatCorrection = () =>
    publicationAction({
      params: { batchNumber: String(batch.batchNumber) },
      request: new Request(
        `http://localhost/api/inventory-batches/${batch.batchNumber}/publications`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "confirm-ambiguous-item",
            publicationId,
            itemId: itemB,
            confirmedQuantity: 4,
            sellerKey,
            confirmedAt: confirmedAtB.toISOString(),
            evidence: { ticket: "T-1", source: "operator-confirmation" },
          }),
        },
      ),
    });
  assert.equal((await repeatCorrection()).init?.status, 200);
  const conflictingCorrection = await publicationAction({
    params: { batchNumber: String(batch.batchNumber) },
    request: new Request(
      `http://localhost/api/inventory-batches/${batch.batchNumber}/publications`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "confirm-ambiguous-item",
          publicationId,
          itemId: itemB,
          confirmedQuantity: 4,
          sellerKey,
          confirmedAt: confirmedAtB.toISOString(),
          evidence: { source: "different-evidence" },
        }),
      },
    ),
  });
  assert.equal(conflictingCorrection.init?.status, 409);

  await inventoryPublicationsRepository.saveItemOutcomes(publicationId, [
    {
      itemId: itemA,
      status: "published",
      confirmedAt: confirmedAtA,
      confirmationEvidence: { source: "test-response", responseId: "one" },
    },
  ]);
  await assert.rejects(
    inventoryPublicationsRepository.saveItemOutcomes(publicationId, [
      {
        itemId: itemA,
        status: "published",
        confirmedAt: new Date("2026-08-11T12:00:00.000Z"),
        confirmationEvidence: { source: "conflicting-callback" },
      },
    ]),
    /different confirmation evidence/,
  );
  activation = await query(
    `SELECT receipt.sku, SUM(link.planned_quantity)::int AS quantity,
      MAX(link.live_at) AS "liveAt", MIN(receipt.seller_key) AS "sellerKey"
    FROM inventory_publication_receipt_links link
    JOIN inventory_receipts receipt ON receipt.receipt_id = link.receipt_id
    WHERE link.publication_item_id = ANY($1::bigint[]) AND link.live_at IS NOT NULL
    GROUP BY receipt.sku ORDER BY receipt.sku`,
    [[itemA, itemB]],
  );
  assert.deepEqual(
    activation.map((row) => ({ sku: row.sku, quantity: row.quantity, liveAt: row.liveAt?.toISOString() })),
    [
      { sku: skuA, quantity: 5, liveAt: confirmedAtA.toISOString() },
      { sku: skuB, quantity: 4, liveAt: confirmedAtB.toISOString() },
    ],
  );
  assert.equal(
    (await inventoryPublicationsRepository.findById(publicationId))?.items[0]
      .forecastEvidence?.decision?.estimatedMedianSellDays,
    24,
    "activation retries never replace the publication-time forecast",
  );

  const priceOnly = await inventoryPublicationsRepository.createOrFindPlanned({
    planningKey: `${prefix}-price-only`,
    method: "staged_delta",
    sourceType: "continuous",
    sellerKey,
    items: [{
      ...publicationItem(batch.batchNumber, 9_200_010, 0),
      candidateKey: `${prefix}-price-only-candidate`,
      inventoryDeltaKey: null,
      batchNumber: null,
    }],
  });
  await inventoryPublicationsRepository.saveItemOutcomes(Number(priceOnly.publication.id), [
    { itemId: Number(priceOnly.publication.items[0].id), status: "published" },
  ]);
  const priceOnlyLinks = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM inventory_publication_receipt_links
    WHERE publication_item_id = $1`,
    [priceOnly.publication.items[0].id],
  );
  assert.equal(priceOnlyLinks?.count, 0);
  await execute(
    `UPDATE inventory_publications
    SET status = 'publishing', claimed_by = 'active-worker',
      claim_expires_at = NOW() + INTERVAL '5 minutes'
    WHERE id = $1`,
    [priceOnly.publication.id],
  );
  assert.equal(
    await inventoryPublicationsRepository.recoverPublicationsWithSavedOutcomes(),
    0,
  );
  assert.equal(
    (await inventoryPublicationsRepository.findById(Number(priceOnly.publication.id)))?.status,
    "publishing",
  );
  await execute(
    `UPDATE inventory_publications SET claim_expires_at = NOW() - INTERVAL '1 minute'
    WHERE id = $1`,
    [priceOnly.publication.id],
  );
  assert.equal(
    await inventoryPublicationsRepository.recoverPublicationsWithSavedOutcomes(),
    1,
  );

  await addReceipt(9_200_020, 1, "mismatch");
  const mismatchBatch = await inventoryBatchesRepository.createFromPendingInventory(
    `${prefix}-mismatch-batch`,
  );
  assert.ok(mismatchBatch);
  await execute(
    `UPDATE inventory_receipts receipt SET seller_key = 'seller-a'
    FROM inventory_receipt_batch_links link
    WHERE link.batch_number = $1 AND link.receipt_id = receipt.receipt_id`,
    [mismatchBatch.batchNumber],
  );
  await assert.rejects(
    inventoryPublicationsRepository.createOrFindPlanned({
      planningKey: `${prefix}-mismatch-plan`,
      batchNumber: mismatchBatch.batchNumber,
      method: "staged_delta",
      sourceType: "pending_inventory",
      sellerKey: "seller-b",
      items: [publicationItem(mismatchBatch.batchNumber, 9_200_020, 1)],
    }),
    /different seller/,
  );
  await assert.rejects(
    inventoryPublicationsRepository.createOrFindPlanned({
      planningKey: `${prefix}-absolute-plan`,
      batchNumber: mismatchBatch.batchNumber,
      method: "direct_absolute",
      sourceType: "pending_inventory",
      sellerKey: "seller-a",
      items: [publicationItem(mismatchBatch.batchNumber, 9_200_020, 1)],
    }),
    /only be published with staged quantity deltas/,
  );

  const recoverySku = 9_200_030;
  await addReceipt(recoverySku, 2, "lease-recovery");
  const recoveryBatch = await inventoryBatchesRepository.createFromPendingInventory(
    `${prefix}-recovery-batch`,
  );
  assert.ok(recoveryBatch);
  const recoveryPlan = await inventoryPublicationsRepository.createOrFindPlanned({
    planningKey: `${prefix}-recovery-plan`,
    batchNumber: recoveryBatch.batchNumber,
    method: "staged_delta",
    sourceType: "pending_inventory",
    sellerKey,
    items: [publicationItem(recoveryBatch.batchNumber, recoverySku, 2)],
  });
  const recoveryPublicationId = Number(recoveryPlan.publication.id);
  const recoveryItemId = Number(recoveryPlan.publication.items[0].id);
  await execute(
    `UPDATE inventory_publications
    SET status = 'publishing', claimed_by = 'lost-worker',
      claim_expires_at = NOW() - INTERVAL '1 minute'
    WHERE id = $1`,
    [recoveryPublicationId],
  );
  assert.equal(await inventoryPublicationsRepository.recoverExpiredClaims(), 1);
  const expired = await inventoryPublicationsRepository.findById(
    recoveryPublicationId,
  );
  assert.equal(expired?.status, "ambiguous");
  assert.equal(expired?.items[0]?.status, "ambiguous");

  const recoveryConfirmedAt = new Date("2026-08-10T13:00:00.000Z");
  const recoveryResponse = await publicationAction({
    params: { batchNumber: String(recoveryBatch.batchNumber) },
    request: new Request(
      `http://localhost/api/inventory-batches/${recoveryBatch.batchNumber}/publications`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "confirm-ambiguous-item",
          publicationId: recoveryPublicationId,
          itemId: recoveryItemId,
          confirmedQuantity: 2,
          sellerKey,
          confirmedAt: recoveryConfirmedAt.toISOString(),
          evidence: { source: "operator-confirmation", ticket: "T-2" },
        }),
      },
    ),
  });
  assert.equal(recoveryResponse.init?.status, 200);
  const recoveredLink = await queryOne<{ liveAt: Date }>(
    `SELECT live_at AS "liveAt"
    FROM inventory_publication_receipt_links
    WHERE publication_item_id = $1`,
    [recoveryItemId],
  );
  assert.equal(recoveredLink?.liveAt.toISOString(), recoveryConfirmedAt.toISOString());
  const beforeIntakeResponse = await publicationAction({
    params: { batchNumber: String(recoveryBatch.batchNumber) },
    request: new Request(
      `http://localhost/api/inventory-batches/${recoveryBatch.batchNumber}/publications`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "confirm-ambiguous-item",
          publicationId: recoveryPublicationId,
          itemId: recoveryItemId,
          confirmedQuantity: 2,
          sellerKey,
          confirmedAt: "2026-01-01T00:00:00.000Z",
          evidence: { source: "conflicting-time" },
        }),
      },
    ),
  });
  assert.equal(beforeIntakeResponse.init?.status, 409);

  console.log("PASS publication outcomes activate exact receipt lots once with safe recovery");
} finally {
  await getPool().end();
}
