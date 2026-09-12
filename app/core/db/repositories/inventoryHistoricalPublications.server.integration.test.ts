import assert from "node:assert/strict";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required.");
const testDatabaseName = new URL(testDatabaseUrl).pathname.replace(/^\/+/, "");
if (!testDatabaseName.startsWith("tcgplayer_strategy_test_")) {
  throw new Error("Historical publication tests require tcgplayer_strategy_test_*.");
}
process.env.DATABASE_URL = testDatabaseUrl;

const { execute, getPool, queryOne } = await import("../database.server");
const { inventorySellingHistoryRepository } = await import("./inventorySellingHistory.server");
const { estimateHistoricalPublicationHistory } = await import(
  "~/features/inventory-strategy/domain/historicalPublicationEstimate"
);

const prefix = `historical-publication-${Date.now()}`;
const cutoff = new Date("2026-09-08T03:34:04.106Z");
const validationCutoff = new Date("2026-09-08T03:39:00.000Z");
const validationFinished = new Date("2026-09-08T03:40:00.000Z");

async function createOpening(seller: string, coverage: Record<string, unknown>) {
  const observation = await queryOne<{ id: string }>(
    `INSERT INTO inventory_complete_observations
      (request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,
       quantity_fingerprint,supported_quantity_fingerprint,first_content_fingerprint,
       second_content_fingerprint,item_count,positive_item_count,total_quantity,
       supported_positive_sku_count,supported_total_quantity,unsupported_positive_item_count,
       unsupported_positive_quantity,identity_evidence)
    VALUES ($1,$2,'seller_portal_live_export','complete','sellable_excludes_reserved',$3,$4,
      'quantity','supported','first','second',1,1,1,1,1,0,0,'{}') RETURNING id::text AS id`,
    [`${seller}:observation`, seller, new Date(cutoff.getTime() - 1_000), cutoff],
  );
  const validation = await queryOne<{ id: string }>(
    `INSERT INTO inventory_complete_observations
      (request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,
       quantity_fingerprint,supported_quantity_fingerprint,first_content_fingerprint,
       second_content_fingerprint,item_count,positive_item_count,total_quantity,
       supported_positive_sku_count,supported_total_quantity,unsupported_positive_item_count,
       unsupported_positive_quantity,identity_evidence)
    VALUES ($1,$2,'seller_portal_live_export','complete','sellable_excludes_reserved',$3,$4,
      'quantity','supported','first','second',1,1,1,1,1,0,0,'{}') RETURNING id::text AS id`,
    [`${seller}:validation`, seller, new Date(validationCutoff.getTime() - 1_000), validationCutoff],
  );
  assert.ok(observation && validation);
  await execute(
    `INSERT INTO inventory_complete_observation_items
      (observation_id,inventory_key,identity_kind,sku,quantity)
    VALUES ($1,'9001','standard_sku',9001,1),($2,'9001','standard_sku',9001,1)`,
    [observation.id, validation.id],
  );
  await execute(
    `INSERT INTO inventory_opening_balance_runs
      (request_id,seller_key,observation_id,order_coverage_run_id,order_coverage_evidence,
       cutoff_at,status,evidence_fingerprint,apply_request_id,validation_observation_id,
       validation_order_coverage_evidence,applied_at)
    VALUES ($1,$2,$3,1,$4::jsonb,$5,'applied','fingerprint',$6,$7,$8::jsonb,$9)`,
    [
      `${seller}:opening`, seller, observation.id, JSON.stringify(coverage), cutoff,
      `${seller}:apply`, validation.id, JSON.stringify(coverage), validationFinished,
    ],
  );
}

async function createPublication(input: {
  seller: string;
  sku: number;
  quantity: number;
  batchQuantity?: number;
  productLine: string;
  confirmedAt?: Date | null;
  parentStatus?: string;
  key?: string;
}) {
  const identity = `${input.seller}:${input.sku}:${input.productLine}:${input.key ?? "only"}`;
  const batch = await queryOne<{ batchNumber: number }>(
    `INSERT INTO inventory_batches (status,source_type,source_label,created_at)
    VALUES ('priced','pending_inventory',$1,$2) RETURNING batch_number AS "batchNumber"`,
    [`${prefix}:${identity}`, new Date("2026-08-20T00:00:00.000Z")],
  );
  assert.ok(batch);
  await execute(
    `INSERT INTO inventory_batch_items
      (batch_number,sku,add_to_quantity,total_quantity,product_line_id,set_id,product_id,created_at,updated_at)
    VALUES ($1,$2,$3,0,1,1,$2,$4,$4)`,
    [batch.batchNumber, input.sku, input.batchQuantity ?? input.quantity, new Date("2026-08-20T00:00:00.000Z")],
  );
  const publication = await queryOne<{ id: string }>(
    `INSERT INTO inventory_publications
      (planning_key,batch_number,method,source_type,seller_key,status,publishing_at,created_at)
    VALUES ($1,$2,'staged_delta','pending_inventory',$3,$4,$5,$6) RETURNING id::text AS id`,
    [
      `${prefix}:publication:${identity}`, batch.batchNumber, input.seller,
      input.parentStatus ?? "published", new Date("2026-08-21T00:00:00.000Z"),
      new Date("2026-08-20T00:00:00.000Z"),
    ],
  );
  assert.ok(publication);
  const confirmedAt = input.confirmedAt === undefined
    ? new Date("2026-08-21T00:01:00.000Z")
    : input.confirmedAt;
  const item = await queryOne<{ id: string }>(
    `INSERT INTO inventory_publication_items
      (publication_id,candidate_key,inventory_delta_key,batch_number,sku,product_id,product_line,
       set_name,product_name,condition,desired_price,quantity_delta,priced_at,status,published_at,created_at)
    VALUES ($1,$2,$3,$4,$5,$5,$6,'Set',$7,'Near Mint',1.00,$8,$9,'published',$10,$11)
    RETURNING id::text AS id`,
    [
      publication.id, `${prefix}:candidate:${identity}`, `${prefix}:delta:${identity}`,
      batch.batchNumber, input.sku, input.productLine, `Card ${input.sku}`, input.quantity,
      new Date("2026-08-20T12:00:00.000Z"), confirmedAt,
      new Date("2026-08-20T00:00:00.000Z"),
    ],
  );
  assert.ok(item);
  return item.id;
}

async function linkPublication(input: {
  seller: string;
  sku: number;
  publicationItemId: string;
  quantity: number;
  key: string;
}) {
  const requestId = `${prefix}:receipt:${input.seller}:${input.sku}:${input.key}`;
  await execute(
    `INSERT INTO inventory_pending_mutations
      (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,
       quantity_delta,resulting_quantity)
    VALUES ($1,'add',$2,$3,1,1,$2,$3,$3)`,
    [requestId, input.sku, input.quantity],
  );
  const receipt = await queryOne<{ id: number }>(
    `INSERT INTO inventory_receipts
      (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,intake_at,market_provenance)
    VALUES ($1,$2,$3,1,1,$2,$4,$5,'unavailable') RETURNING receipt_id AS id`,
    [requestId, input.sku, input.quantity, input.seller, new Date("2026-08-20T00:00:00.000Z")],
  );
  assert.ok(receipt);
  await execute(
    `INSERT INTO inventory_publication_receipt_links
      (publication_item_id,receipt_id,planned_quantity,target_seller_key,live_at,activated_at,
       confirmation_evidence)
    VALUES ($1,$2,$3,$4,$5,$5,'{"source":"historical-publication-test"}'::jsonb)`,
    [
      input.publicationItemId, receipt.id, input.quantity, input.seller,
      new Date("2026-08-21T00:01:00.000Z"),
    ],
  );
}

async function createOrder(seller: string, sku: number, quantity = 1) {
  const order = await queryOne<{ id: string }>(
    `INSERT INTO seller_orders
      (seller_key,order_number,order_time,lifecycle,provider_status,gross_item_proceeds,
       source_revision,source_fingerprint,first_observed_at,last_observed_at,detail_observed_at,latest_source)
    VALUES ($1,$2,$3,'completed_paid','Completed',1.00,2,'financial-refresh',$4,$5,$5,'tcgplayer_api')
    RETURNING id::text AS id`,
    [seller, `${prefix}:order:${sku}`, new Date("2026-08-25T00:00:00.000Z"),
      new Date("2026-09-08T03:35:00.000Z"), new Date("2026-09-09T00:00:00.000Z")],
  );
  assert.ok(order);
  await execute(
    `INSERT INTO seller_order_lines
      (order_id,sku_id,product_name,ordered_quantity,gross_item_proceeds)
    VALUES ($1,$2,'Card',$3,1.00)`,
    [order.id, String(sku), quantity],
  );
  const lines = JSON.stringify([{ skuId: String(sku), quantity }]);
  await execute(
    `INSERT INTO seller_order_revisions
      (order_id,revision_number,source_fingerprint,source,observed_at,order_time,
       order_time_evidence,provider_status,lifecycle,line_evidence)
    VALUES
      ($1,1,'original','tcgplayer_api',$2,$3,'detail_canonical','Processing','processing',$4::jsonb),
      ($1,2,'financial-refresh','tcgplayer_api',$5,$3,'detail_canonical','Completed','completed_paid',$4::jsonb)`,
    [
      order.id, new Date("2026-09-08T03:35:00.000Z"),
      new Date("2026-08-25T00:00:00.000Z"), lines,
      new Date("2026-09-09T00:00:00.000Z"),
    ],
  );
}

try {
  const seller = `${prefix}:seller`;
  const coverage = {
    id: "1",
    finishedAt: validationFinished.toISOString(),
    ordersObserved: 2,
    detailsRecorded: 2,
  };
  await createOpening(seller, coverage);
  await createPublication({ seller, sku:9001, quantity:2, productLine:"Pokemon", parentStatus:"ambiguous" });
  await createPublication({ seller, sku:9002, quantity:1, productLine:"Magic" });
  await createPublication({ seller, sku:9003, quantity:1, productLine:"Magic", confirmedAt:null });
  await createPublication({ seller, sku:9004, quantity:2, batchQuantity:1, productLine:"Pokemon" });
  await createOrder(seller, 9001);
  await createOrder(seller, 9002);

  const source = await inventorySellingHistoryRepository.findEvidence(
    seller,
    { windowDays:180, productLine:null },
  );
  assert.equal(source.historicalPublicationEvidence.sourceAvailable, true);
  assert.equal(source.historicalPublicationEvidence.coverageComplete, true);
  assert.equal(source.historicalPublicationEvidence.additionCount, 4);
  assert.equal(source.historicalPublicationEvidence.additions.length, 4);
  assert.ok(source.historicalPublicationEvidence.additions.every((row) =>
    row.skuProductLineCount === 1));
  assert.ok(source.historicalPublicationEvidence.additions.every((row) =>
    row.linkedPreCutoffPublicationCount === 0));
  assert.equal(source.historicalPublicationEvidence.orderRevisionCount, 4);
  assert.deepEqual(source.availableProductLines, ["Magic", "Pokemon"]);
  const estimate = estimateHistoricalPublicationHistory(source.historicalPublicationEvidence);
  assert.equal(estimate.status, "ready");
  assert.equal(estimate.summary.publicationQuantity, 6);
  assert.equal(estimate.summary.confirmedAdditionQuantity, 5);
  assert.equal(estimate.summary.estimatedAdditionQuantity, 3);
  assert.equal(estimate.summary.estimatedSoldQuantity, 2);
  assert.equal(estimate.summary.estimatedRemainingAtCutoff, 1);
  assert.equal(estimate.summary.unsupportedAdditionQuantity, 3);
  assert.equal(estimate.cohorts.find((row) => row.sku === 9002)?.estimatedRemainingAtCutoff, 0,
    "absence from the validated complete observation is a known zero opening quantity");
  assert.deepEqual(estimate.cohorts.find((row) => row.sku === 9003)?.reasons,
    ["publication_evidence_invalid"]);
  assert.deepEqual(estimate.cohorts.find((row) => row.sku === 9004)?.reasons,
    ["publication_evidence_invalid"]);

  const magic = await inventorySellingHistoryRepository.findEvidence(
    seller,
    { windowDays:180, productLine:"Magic" },
  );
  assert.deepEqual(magic.historicalPublicationEvidence.additions.map((row) => row.sku), [9002,9003]);

  const invalidSeller = `${prefix}:invalid-seller`;
  await createOpening(invalidSeller, {});
  await createPublication({ seller:invalidSeller, sku:9010, quantity:1, productLine:"Magic" });
  const invalid = await inventorySellingHistoryRepository.findEvidence(
    invalidSeller,
    { windowDays:180, productLine:null },
  );
  assert.equal(invalid.historicalPublicationEvidence.coverageComplete, false);
  assert.equal(estimateHistoricalPublicationHistory(invalid.historicalPublicationEvidence).reason,
    "order_coverage_incomplete");

  const crossLineSeller = `${prefix}:cross-line-seller`;
  await createOpening(crossLineSeller, coverage);
  await createPublication({ seller:crossLineSeller, sku:9020, quantity:1, productLine:"Pokemon" });
  await createPublication({ seller:crossLineSeller, sku:9020, quantity:1, productLine:"Magic" });
  const crossLineAll = await inventorySellingHistoryRepository.findEvidence(
    crossLineSeller,
    { windowDays:180, productLine:null },
  );
  assert.deepEqual(crossLineAll.historicalPublicationEvidence.additions.map((row) =>
    row.skuProductLineCount), [2,2]);
  assert.ok(estimateHistoricalPublicationHistory(crossLineAll.historicalPublicationEvidence)
    .cohorts.every((row) => row.reasons.includes("publication_identity_conflict")));
  const crossLineScoped = await inventorySellingHistoryRepository.findEvidence(
    crossLineSeller,
    { windowDays:180, productLine:"Pokemon" },
  );
  assert.equal(crossLineScoped.historicalPublicationEvidence.additions.length, 1);
  assert.equal(crossLineScoped.historicalPublicationEvidence.additions[0].skuProductLineCount, 2,
    "the complete seller/SKU identity check runs before product-line filtering");
  const scopedEstimate = estimateHistoricalPublicationHistory(crossLineScoped.historicalPublicationEvidence);
  assert.deepEqual(scopedEstimate.cohorts[0].reasons, ["publication_identity_conflict"]);
  assert.equal(scopedEstimate.summary.reconstructedOlderQuantity, 0);

  const mixedSeller = `${prefix}:mixed-source-seller`;
  await createOpening(mixedSeller, coverage);
  const linkedSameSku = await createPublication({
    seller:mixedSeller, sku:9030, quantity:1, productLine:"Pokemon", key:"linked",
  });
  await linkPublication({
    seller:mixedSeller, sku:9030, publicationItemId:linkedSameSku, quantity:1, key:"same-sku",
  });
  await createPublication({
    seller:mixedSeller, sku:9030, quantity:1, productLine:"Pokemon", key:"unlinked",
  });
  const linkedOtherSku = await createPublication({
    seller:mixedSeller, sku:9031, quantity:1, productLine:"Pokemon", key:"linked",
  });
  await linkPublication({
    seller:mixedSeller, sku:9031, publicationItemId:linkedOtherSku, quantity:1, key:"other-sku",
  });
  await createPublication({
    seller:mixedSeller, sku:9032, quantity:1, productLine:"Pokemon", key:"unlinked",
  });
  await createOrder(mixedSeller, 9030, 2);
  await createOrder(mixedSeller, 9032);
  const mixedSource = await inventorySellingHistoryRepository.findEvidence(
    mixedSeller,
    { windowDays:180, productLine:null },
  );
  assert.deepEqual(mixedSource.historicalPublicationEvidence.additions.map((row) => [
    row.sku,
    row.linkedPreCutoffPublicationCount,
  ]), [[9030,1],[9032,0]],
  "linked publications are excluded from legacy counts but detected for the same candidate SKU");
  const mixedEstimate = estimateHistoricalPublicationHistory(mixedSource.historicalPublicationEvidence);
  assert.deepEqual(mixedEstimate.cohorts.find((row) => row.sku === 9030)?.reasons,
    ["mixed_publication_receipt_sources"]);
  assert.equal(mixedEstimate.cohorts.find((row) => row.sku === 9032)?.attributionProvenance,
    "estimated_closed_flow", "a receipt-linked publication for another SKU does not block the candidate");
  assert.equal(mixedEstimate.summary.reconstructedOlderQuantity, 0,
    "hidden linked supply is not reconstructed as older stock");

  console.log("PASS historical publication repository preserves scoped facts and validated opening authority");
} finally {
  await getPool().end();
}
