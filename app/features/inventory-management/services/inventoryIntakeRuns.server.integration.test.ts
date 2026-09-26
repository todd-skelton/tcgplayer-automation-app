import assert from "node:assert/strict";
import {
  execute,
  getDatabaseUrl,
  getPool,
  query,
  queryOne,
} from "~/core/db/database.server";
import {
  inventoryBatchesRepository,
  inventoryBatchPricingJobsRepository,
  pendingInventoryRepository,
  shippingExportConfigRepository,
  pricingConfigRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { createDefaultShippingExportConfig } from "~/features/shipping-export/types/shippingExport";
import { DEFAULT_INVENTORY_PUBLICATION_POLICY } from "~/features/inventory-publication/types/inventoryPublication";
import { planNextQueuedIntakePublication } from "~/features/inventory-publication/services/queuedIntakePublication.server";
import { planAutomaticInventoryBatchPublication } from "~/features/inventory-publication/services/automaticInventoryBatchPublication.server";
import type { InventoryBatch } from "~/features/pending-inventory/types/inventoryBatch";
import type { TcgPlayerListing } from "~/core/types/pricing";
import {
  queueInventoryIntake,
  findRecentInventoryIntakeRuns,
} from "./inventoryIntakeRuns.server";

// This test deliberately injects database failures and must never use an app database.
assert.match(
  new URL(getDatabaseUrl()).pathname,
  /^\/inventory_intake_queue_test\w*$/,
);
const prefix = `intake-${Date.now()}`;
let mutationNumber = 0;
const add = (sku: number, quantity: number) =>
  pendingInventoryRepository.mutate({
    type: "add",
    requestId: `${prefix}-add-${++mutationNumber}`,
    sku,
    quantity,
    metadata: { productLineId: 3, setId: 1, productId: sku },
    intakeAt: new Date(),
    market: {
      marketValue: null,
      observedAt: null,
      calculatedAt: null,
      provenance: "tcgplayer_price_points_unavailable",
    },
  });
async function price(batch: InventoryBatch, stale = false) {
  const items = await inventoryBatchesRepository.findItems(batch.batchNumber);
  await inventoryBatchesRepository.saveResults({
    batchNumber: batch.batchNumber,
    mode: "full",
    rows: items.map((item) => ({
      sku: item.sku,
      resultStatus: "successful",
      pricingDetails: null,
      errorMessages: [],
      warningMessages: [],
      pricedAt: stale ? new Date(Date.now() - 2 * 60 * 60 * 1000) : new Date(),
      row: {
        "TCGplayer Id": String(item.sku),
        "Product Line": "Pokemon",
        "Set Name": "Test",
        Product: "Test card",
        "Sku Variant": "Normal",
        "Sku Condition": "Near Mint",
        "TCG Marketplace Price": "2.00",
        "Total Quantity": "0",
        "Add to Quantity": String(item.addToQuantity),
        "Previous Price": "",
      } as TcgPlayerListing,
    })),
  });
  await execute(
    "UPDATE inventory_batch_pricing_jobs SET status = 'completed' WHERE id = $1",
    [batch.latestJob!.id],
  );
}
const publications = (batch: InventoryBatch) =>
  query<{ quantity: number }>(
    "SELECT quantity_delta AS quantity FROM inventory_publication_items WHERE batch_number = $1",
    [batch.batchNumber],
  );

try {
  assert.equal(
    (await pendingInventoryRepository.findAll()).length,
    0,
    "isolated database must start without pending inventory",
  );
  await shippingExportConfigRepository.save({
    ...createDefaultShippingExportConfig(),
    defaultSellerKey: "intake-test-seller",
  });
  const publicationSettings =
    await inventoryPublicationSettingsRepository.get();
  await inventoryPublicationSettingsRepository.save({
    ...publicationSettings.settings,
    continuousPricing: {
      ...publicationSettings.settings.continuousPricing,
      sellerKey: "intake-test-seller",
    },
  });
  await add(9100101, 3);
  const request = {
    requestId: `${prefix}-first`,
    workflow: "publish" as const,
    expectedInventory: [{ sku: 9100101, quantity: 3 }],
    expectedSellerKey: "intake-test-seller",
    purchaseCost: {
      purchaseReference: "first lot",
      totalAmount: "3.00",
      provenance: "actual",
      allocationRule: "quantity",
      currency: "USD",
    },
  };
  const [first, replay] = await Promise.all([
    queueInventoryIntake(request),
    queueInventoryIntake(request),
  ]);
  assert.ok(first && replay);
  assert.equal(first.batchNumber, replay.batchNumber);
  assert.equal(first.latestJob!.id, replay.latestJob!.id);
  assert.equal(first.latestJob!.priority, 300);
  assert.equal((await pendingInventoryRepository.findAll()).length, 0);
  assert.equal(
    (
      await query(
        "SELECT id FROM inventory_batch_pricing_jobs WHERE batch_number = $1",
        [first.batchNumber],
      )
    ).length,
    1,
  );
  await assert.rejects(
    queueInventoryIntake({ ...request, workflow: "price_only" }),
    /different options/,
  );
  await assert.rejects(
    queueInventoryIntake({
      ...request,
      purchaseCost: { ...request.purchaseCost, totalAmount: "4.00" },
    }),
    /different options/,
  );
  await add(9100101, 2);
  await queueInventoryIntake(request);
  assert.equal(
    (await pendingInventoryRepository.findAll())[0].quantity,
    2,
    "response replay cannot drain newer additions",
  );
  const second = await queueInventoryIntake({
    requestId: `${prefix}-second`,
    workflow: "price_only",
    expectedInventory: [{ sku: 9100101, quantity: 2 }],
    expectedSellerKey: "intake-test-seller",
  });
  assert.ok(second);
  assert.equal(
    (await inventoryBatchesRepository.findItems(first.batchNumber))[0]
      .addToQuantity,
    3,
  );
  assert.equal(
    (await inventoryBatchesRepository.findItems(second.batchNumber))[0]
      .addToQuantity,
    2,
  );
  await price(first);
  await price(second);
  await Promise.all([
    planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY),
    planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY),
  ]);
  assert.deepEqual(
    (await publications(first)).map((item) => item.quantity),
    [3],
  );
  assert.equal((await publications(second)).length, 0);
  assert.equal(
    (await planAutomaticInventoryBatchPublication(second.batchNumber)).planned,
    false,
  );
  await planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY);
  assert.equal(
    (await publications(first)).length,
    1,
    "repeated worker ticks cannot duplicate a quantity delta",
  );
  console.log(
    "PASS atomic handoff, concurrent duplicate request, stable cost/mode, new copies and explicit publication while global auto is off",
  );

  await add(9100102, 1);
  await execute(
    `CREATE FUNCTION reject_intake_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected job failure'; END $$`,
  );
  await execute(
    "CREATE TRIGGER reject_intake_job BEFORE INSERT ON inventory_batch_pricing_jobs FOR EACH ROW EXECUTE FUNCTION reject_intake_job()",
  );
  const rollbackRequest = {
    requestId: `${prefix}-rollback`,
    workflow: "publish" as const,
    expectedInventory: [{ sku: 9100102, quantity: 1 }],
    expectedSellerKey: "intake-test-seller",
  };
  await assert.rejects(
    queueInventoryIntake(rollbackRequest),
    /injected job failure/,
  );
  assert.equal((await pendingInventoryRepository.findAll())[0].quantity, 1);
  assert.equal(
    await queryOne(
      "SELECT request_id FROM inventory_batch_intake_requests WHERE request_id = $1",
      [rollbackRequest.requestId],
    ),
    null,
  );
  await execute(
    "DROP TRIGGER reject_intake_job ON inventory_batch_pricing_jobs",
  );
  await execute("DROP FUNCTION reject_intake_job()");
  const recovered = await queueInventoryIntake(rollbackRequest);
  assert.ok(recovered);
  await price(recovered, true);
  await planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY);
  assert.equal((await publications(recovered)).length, 0);
  assert.equal(
    (await findRecentInventoryIntakeRuns()).find(
      (run) => run.batchNumber === recovered.batchNumber,
    )?.planningStatus,
    "needs_review",
  );
  console.log(
    "PASS failed job creation rolls back intake; retry succeeds; stale candidates remain unpublished",
  );

  await add(9100103, 1);
  await add(9100104, 2);
  const multi = await queueInventoryIntake({
    requestId: `${prefix}-multi`,
    workflow: "publish",
    expectedInventory: [
      { sku: 9100103, quantity: 1 },
      { sku: 9100104, quantity: 2 },
    ],
    expectedSellerKey: "intake-test-seller",
  });
  assert.ok(multi);
  await price(multi);
  await execute(`CREATE FUNCTION reject_second_intake_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.sku = 9100104 THEN RAISE EXCEPTION 'injected second publication failure'; END IF; RETURN NEW; END $$`);
  await execute(
    "CREATE TRIGGER reject_second_intake_publication BEFORE INSERT ON inventory_publication_items FOR EACH ROW EXECUTE FUNCTION reject_second_intake_publication()",
  );
  const smallPolicy = {
    ...DEFAULT_INVENTORY_PUBLICATION_POLICY,
    stagedMicroBatchMaximum: 1,
  };
  await planNextQueuedIntakePublication(smallPolicy);
  assert.equal(
    (await publications(multi)).length,
    0,
    "all chunks roll back if later planning fails",
  );
  let status = (await findRecentInventoryIntakeRuns()).find(
    (run) => run.batchNumber === multi.batchNumber,
  )!;
  assert.match(status.planningError!, /injected second/);
  assert.equal(status.planningStatus, "waiting");
  await execute(
    "DROP TRIGGER reject_second_intake_publication ON inventory_publication_items",
  );
  await execute("DROP FUNCTION reject_second_intake_publication()");
  await execute(
    "UPDATE inventory_intake_runs SET next_attempt_at = NOW() WHERE batch_number = $1",
    [multi.batchNumber],
  );
  await planNextQueuedIntakePublication(smallPolicy);
  assert.deepEqual(
    (await publications(multi)).map((item) => item.quantity).sort(),
    [1, 2],
  );
  status = (await findRecentInventoryIntakeRuns()).find(
    (run) => run.batchNumber === multi.batchNumber,
  )!;
  assert.equal(status.publishingCount, 2);
  assert.equal(status.reviewCount, 0);
  console.log(
    "PASS publication planning is all-or-nothing across chunks and recoverable after a worker failure",
  );

  await add(9100105, 1);
  const superseded = await queueInventoryIntake({
    requestId: `${prefix}-superseded`,
    workflow: "publish",
    expectedInventory: [{ sku: 9100105, quantity: 1 }],
    expectedSellerKey: "intake-test-seller",
  });
  assert.ok(superseded);
  await price(superseded);
  await inventoryBatchPricingJobsRepository.createOrReuseActiveJob(
    superseded.batchNumber,
    "full",
    await pricingConfigRepository.get(),
  );
  await planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY);
  assert.equal((await publications(superseded)).length, 0);
  assert.equal(
    (await findRecentInventoryIntakeRuns()).find(
      (run) => run.batchNumber === superseded.batchNumber,
    )?.planningStatus,
    "needs_review",
  );
  console.log(
    "PASS publication permission does not silently transfer to a replacement pricing job",
  );

  await add(9100106, 1);
  const frozen = {
    requestId: `${prefix}-frozen`,
    workflow: "publish" as const,
    expectedInventory: [{ sku: 9100106, quantity: 1 }],
    expectedSellerKey: "intake-test-seller",
  };
  await add(9100107, 1);
  await assert.rejects(
    queueInventoryIntake(frozen),
    /shared inventory queue changed/,
  );
  const refreshed = {
    ...frozen,
    expectedInventory: [
      { sku: 9100106, quantity: 1 },
      { sku: 9100107, quantity: 1 },
    ],
  };
  await assert.rejects(
    queueInventoryIntake({ ...refreshed, expectedSellerKey: "wrong-seller" }),
    /seller changed/,
  );
  await inventoryPublicationSettingsRepository.save({
    ...publicationSettings.settings,
    continuousPricing: {
      ...publicationSettings.settings.continuousPricing,
      sellerKey: "different-seller",
    },
  });
  await assert.rejects(queueInventoryIntake(refreshed), /must match/);
  await inventoryPublicationSettingsRepository.save({
    ...publicationSettings.settings,
    continuousPricing: {
      ...publicationSettings.settings.continuousPricing,
      sellerKey: "intake-test-seller",
    },
  });
  const frozenBatch = await queueInventoryIntake(refreshed);
  assert.ok(frozenBatch);
  await price(frozenBatch);
  await inventoryPublicationSettingsRepository.save({
    ...publicationSettings.settings,
    continuousPricing: {
      ...publicationSettings.settings.continuousPricing,
      sellerKey: "different-seller",
    },
  });
  await planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY);
  assert.equal((await publications(frozenBatch)).length, 0);
  assert.equal(
    (await findRecentInventoryIntakeRuns()).find(
      (run) => run.batchNumber === frozenBatch.batchNumber,
    )?.planningStatus,
    "needs_review",
  );
  console.log(
    "PASS unseen inventory, stale recovery snapshots, mismatched sellers and changed publication targets cannot gain publish permission",
  );
  await inventoryPublicationSettingsRepository.save({
    ...publicationSettings.settings,
    continuousPricing: {
      ...publicationSettings.settings.continuousPricing,
      sellerKey: "intake-test-seller",
    },
  });
  await add(9100108, 1);
  const failed = await queueInventoryIntake({
    requestId: `${prefix}-failed`,
    workflow: "publish",
    expectedInventory: [{ sku: 9100108, quantity: 1 }],
    expectedSellerKey: "intake-test-seller",
  });
  assert.ok(failed);
  await inventoryBatchPricingJobsRepository.fail(
    failed.latestJob!.id,
    failed.batchNumber,
    "injected pricing failure",
  );
  await planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY);
  assert.equal(
    (await findRecentInventoryIntakeRuns()).find(
      (run) => run.batchNumber === failed.batchNumber,
    )?.planningStatus,
    "needs_review",
  );
  await inventoryBatchPricingJobsRepository.createOrReuseActiveJob(
    failed.batchNumber,
    "full",
    await pricingConfigRepository.get(),
  );
  const repriced = await inventoryBatchesRepository.findByBatchNumber(
    failed.batchNumber,
  );
  await price(repriced!);
  await planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY);
  const failedStatus = (await findRecentInventoryIntakeRuns()).find(
    (run) => run.batchNumber === failed.batchNumber,
  )!;
  assert.equal(failedStatus.pricingStatus, "completed");
  assert.equal(failedStatus.planningStatus, "needs_review");
  assert.equal((await publications(failed)).length, 0);
  console.log(
    "PASS failed pricing requires review and subsequent repricing shows current status without inheriting publish permission",
  );

  await add(9100109, 1);
  const capped = await queueInventoryIntake({
    requestId: `${prefix}-capped`,
    workflow: "publish",
    expectedInventory: [{ sku: 9100109, quantity: 1 }],
    expectedSellerKey: "intake-test-seller",
  });
  assert.ok(capped);
  await price(capped);
  await execute(`CREATE FUNCTION reject_capped_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.sku = 9100109 THEN RAISE EXCEPTION 'persistent planning failure'; END IF; RETURN NEW; END $$`);
  await execute(
    "CREATE TRIGGER reject_capped_publication BEFORE INSERT ON inventory_publication_items FOR EACH ROW EXECUTE FUNCTION reject_capped_publication()",
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await execute(
      "UPDATE inventory_intake_runs SET next_attempt_at = NOW() WHERE batch_number = $1",
      [capped.batchNumber],
    );
    await planNextQueuedIntakePublication(DEFAULT_INVENTORY_PUBLICATION_POLICY);
  }
  assert.equal(
    (await findRecentInventoryIntakeRuns()).find(
      (run) => run.batchNumber === capped.batchNumber,
    )?.planningStatus,
    "needs_review",
  );
  assert.equal((await publications(capped)).length, 0);
  await execute(
    "DROP TRIGGER reject_capped_publication ON inventory_publication_items",
  );
  await execute("DROP FUNCTION reject_capped_publication()");
  console.log(
    "PASS persistent planning failures stop retrying after three attempts without publishing any quantity",
  );
} finally {
  await getPool().end();
}
