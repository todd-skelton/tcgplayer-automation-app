import assert from "node:assert/strict";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || process.env.DATABASE_URL !== testUrl) {
  throw new Error("DATABASE_URL and TEST_DATABASE_URL must match before the rollout integration test.");
}
if (!new URL(testUrl).pathname.replace(/^\/+/, "").startsWith("tcgplayer_fifo_test_")) {
  throw new Error("The rollout integration test requires a disposable tcgplayer_fifo_test_* database.");
}

const { getPool } = await import("~/core/db/database.server");
const { pendingInventoryRepository } = await import("~/core/db/repositories/pendingInventory.server");
const { inventoryBatchesRepository } = await import("~/core/db/repositories/inventoryBatches.server");
const { inventoryPublicationsRepository } = await import("~/core/db/repositories/inventoryPublications.server");
const { inventoryOpeningBalancesRepository } = await import("~/core/db/repositories/inventoryOpeningBalances.server");
const { inventoryFifoRepository } = await import("~/core/db/repositories/inventoryFifo.server");
const { inventoryHistoryDiagnosticsRepository } = await import("~/core/db/repositories/inventoryHistoryDiagnostics.server");
const { sellerOrderHistoryRepository } = await import("~/core/db/repositories/sellerOrderHistory.server");
const { quantityFingerprint, supportedQuantityFingerprint } = await import("~/features/inventory-opening-balance/domain/inventoryObservation");
const { fingerprintSellerOrder } = await import("~/features/seller-order-history/domain/sellerOrderObservation");
const { enrichShippingOrdersWithIntakeHistory } = await import("~/features/shipping-export/services/shippingIntakeHistory.server");
const { compareOrderToIntake } = await import("~/features/shipping-export/services/orderIntakeComparison");
const { attachMarketPricesToOrders } = await import("~/features/shipping-export/services/orderMarketPrices.server");

const pool = getPool();
const suffix = Date.now();
const seller = `rollout-${suffix}`;
const sku = 9_610_001;
const productId = 9_610_002;
const setId = 9_610_003;
const productLineId = 9_610_004;
const now = Date.now();
const openingCutoff = new Date(now - 120_000);
const validationCutoff = new Date(now - 30_000);
const publishedAt = new Date(now + 30_000);
const soldAt = new Date(now + 60_000);

async function completeObservation(requestId: string, cutoffAt: Date) {
  const items = [{ inventoryKey: String(sku), identityKind: "standard_sku" as const, sku, quantity: 0,
    productLine: "Synthetic", setName: "Rollout Set", productName: "Rollout Card", condition: "Near Mint", variant: "Normal" }];
  const claim = await inventoryOpeningBalancesRepository.beginObservationCapture({ requestId, sellerKey: seller });
  if (claim.state !== "claimed") throw new Error("Expected a new observation claim.");
  return inventoryOpeningBalancesRepository.recordObservation({
    requestId, sellerKey: seller, claimToken: claim.claimToken, status: "complete",
    beforeIdentityDeclarationCount: 2, afterIdentityDeclarationCount: 2,
    startedAt: new Date(cutoffAt.getTime() - 2_000), cutoffAt,
    quantityFingerprint: quantityFingerprint(items), supportedQuantityFingerprint: supportedQuantityFingerprint(items),
    firstContentFingerprint: `${requestId}-a`, secondContentFingerprint: `${requestId}-b`, items,
  });
}

async function addCoverage(after: Date) {
  await pool.query(`INSERT INTO seller_order_sync_runs
    (seller_key,source,status,search_range,started_at,finished_at,next_offset,expected_total,pages_completed,orders_observed,details_recorded,
     observed_from,observed_through,gaps)
    VALUES ($1,'tcgplayer_api','complete','LastThreeMonths',$2,$3,0,0,1,0,0,NULL,NULL,'[]')`,
  [seller, after, new Date(after.getTime() + 1_000)]);
}

try {
  await pool.query(`INSERT INTO products
    (product_id,product_type_name,rarity_name,sealed,product_name,set_id,set_code,set_name,product_line_id,product_status_id,product_line_name)
    VALUES ($1,'Card','Rare',false,'Rollout Card',$2,'R','Rollout Set',$3,1,'Synthetic')`, [productId, setId, productLineId]);
  await pool.query(`INSERT INTO skus
    (sku,condition,variant,language,product_type_name,rarity_name,sealed,product_name,set_id,set_code,product_id,set_name,
     product_line_id,product_status_id,product_line_name)
    VALUES ($1,'Near Mint','Normal','English','Card','Rare',false,'Rollout Card',$2,'R',$3,'Rollout Set',$4,1,'Synthetic')`,
  [sku, setId, productId, productLineId]);

  const openingObservation = await completeObservation(`${seller}-opening-observation`, openingCutoff);
  await addCoverage(openingCutoff);
  const preview = await inventoryOpeningBalancesRepository.preview({
    requestId: `${seller}-opening-preview`, sellerKey: seller, observationId: openingObservation.id,
  });
  assert.equal(preview.status, "previewed");
  assert.equal(preview.totalQuantity, 0);
  const validation = await completeObservation(`${seller}-opening-validation`, validationCutoff);
  await addCoverage(validationCutoff);
  const applyInput = { runId: preview.id, expectedFingerprint: preview.evidenceFingerprint, sellerKey: seller,
    requestId: `${seller}-opening-apply`, validationObservationId: validation.id };
  assert.equal((await inventoryOpeningBalancesRepository.apply(applyInput)).status, "applied");
  assert.equal((await inventoryOpeningBalancesRepository.apply(applyInput)).status, "applied");

  const metadata = { productLineId, setId, productId };
  const addFirst = { type: "add" as const, requestId: `${seller}-receipt-a`, sku, quantity: 2, metadata,
    intakeAt: new Date(soldAt.getTime() - 60 * 86_400_000),
    market: { marketValue: 4, observedAt: new Date(), calculatedAt: new Date(), provenance: "tcgplayer_price_points" as const } };
  const first = await pendingInventoryRepository.mutate(addFirst);
  assert.equal(first.quantity, 2);
  assert.equal((await pendingInventoryRepository.mutate(addFirst)).repeated, true);
  await pendingInventoryRepository.mutate({ type: "add", requestId: `${seller}-receipt-b`, sku, quantity: 1, metadata,
    intakeAt: new Date(soldAt.getTime() - 10 * 86_400_000),
    market: { marketValue: 6, observedAt: new Date(), calculatedAt: new Date(), provenance: "tcgplayer_price_points" } });
  const batch = await inventoryBatchesRepository.createFromPendingInventory(`${seller}-batch`);
  assert.ok(batch);
  assert.equal((await inventoryBatchesRepository.createFromPendingInventory(`${seller}-batch`))?.batchNumber, batch.batchNumber);

  const planInput = { planningKey: `${seller}-publication`, batchNumber: batch.batchNumber,
    method: "staged_delta" as const, sourceType: "pending_inventory" as const, sellerKey: seller,
    items: [{ candidateKey: `${seller}-candidate`, inventoryDeltaKey: `${seller}-delta`, batchNumber: batch.batchNumber,
      sku, productId, productLine: "Synthetic", setName: "Rollout Set", productName: "Rollout Card", condition: "Near Mint",
      desiredPrice: 8, quantityDelta: 3, pricedAt: new Date(now) }] };
  const planned = await inventoryPublicationsRepository.createOrFindPlanned(planInput);
  assert.equal((await inventoryPublicationsRepository.createOrFindPlanned(planInput)).created, false);
  await pool.query(`UPDATE inventory_publications SET status='publishing' WHERE id=$1`, [planned.publication.id]);
  const publicationItemId = Number(planned.publication.items[0]?.id);
  const outcome = { itemId: publicationItemId, status: "published" as const, confirmedAt: publishedAt,
    confirmationEvidence: { source: "synthetic-rollout", confirmation: "confirmed-positive-delta" } };
  await inventoryPublicationsRepository.saveItemOutcomes(Number(planned.publication.id), [outcome]);
  await inventoryPublicationsRepository.saveItemOutcomes(Number(planned.publication.id), [outcome]);
  await pool.query(`UPDATE inventory_publications SET status='published',published_at=$2,completed_at=$2 WHERE id=$1`,
    [planned.publication.id, publishedAt]);

  const orderBase = { sellerKey: seller, orderNumber: `${seller}-order`, orderTime: soldAt.toISOString(),
    providerStatus: "Ready to Ship", lifecycle: "ready_to_ship" as const, orderChannel: "TcgMarketplace",
    orderFulfillment: "Normal", grossItemProceeds: 24, refunds: [], source: "tcgplayer_api" as const,
    lines: [{ name: "Rollout Card", unitPrice: 8, extendedPrice: 24, quantity: 3, productId: String(productId), skuId: String(sku) }] };
  const order = { ...orderBase, observedAt: new Date(now + 70_000).toISOString(), fingerprint: fingerprintSellerOrder(orderBase) };
  assert.equal((await sellerOrderHistoryRepository.recordObservation(order)).changed, true);
  assert.equal((await sellerOrderHistoryRepository.recordObservation(order)).changed, false);
  const replay = await inventoryFifoRepository.processNextReplay(seller);
  assert.equal(replay?.status, "complete");
  assert.equal(await inventoryFifoRepository.processNextReplay(seller), null);

  const shippingOrder = { "Order #": order.orderNumber, FirstName: "", LastName: "", Address1: "", Address2: "", City: "",
    State: "", PostalCode: "", Country: "US", "Order Date": soldAt.toISOString(), "Product Weight": 0,
    "Shipping Method": "Standard" as const, "Item Count": 3, "Value Of Products": 24, "Shipping Fee Paid": 0,
    "Tracking #": "", Carrier: "", products: [{ name: "Rollout Card", quantity: 3, unitPrice: 8, skuId: sku, inventorySkuId: String(sku) }] };
  const enriched = (await enrichShippingOrdersWithIntakeHistory([shippingOrder], seller))[0]!;
  const comparison = compareOrderToIntake(enriched);
  assert.deepEqual([comparison.orderedQuantity, comparison.matchedQuantity, comparison.priceKnownQuantity, comparison.dateKnownQuantity], [3, 3, 3, 3]);
  assert.equal(comparison.intakeMarketTotal, 14);
  assert.ok(Math.abs((comparison.weightedDaysHeld ?? 0) - 43.333333) < 0.000001);
  const failedMarket = await attachMarketPricesToOrders([enriched], async () => { throw new Error("synthetic market outage"); });
  assert.match(failedMarket.warning ?? "", /market comparisons are unavailable/i);
  assert.equal(compareOrderToIntake(failedMarket.orders[0]!).intakeMarketTotal, 14);

  const conservation = await pool.query(`SELECT
    (SELECT COALESCE(SUM(original_quantity),0)::int FROM inventory_receipts WHERE seller_key=$1 AND receipt_kind='received') AS received,
    (SELECT COALESCE(SUM(allocation.allocated_quantity),0)::int FROM inventory_fifo_revision_allocations allocation
      JOIN inventory_fifo_lines line ON line.current_revision_id=allocation.revision_id WHERE line.seller_key=$1) AS allocated`, [seller]);
  assert.deepEqual(conservation.rows[0], { received: 3, allocated: 3 });
  const diagnostics = await inventoryHistoryDiagnosticsRepository.get(seller);
  assert.equal(diagnostics.openingBalance.status, "applied");
  assert.equal(diagnostics.orderCoverage.status, "complete");
  assert.equal(diagnostics.fifo.matchedQuantity, 3);
  assert.equal(diagnostics.fifo.unmatchedQuantity, 0);
  assert.equal(diagnostics.receivedLots.missingMarketSnapshotQuantity, 0);
  assert.equal(diagnostics.publications.failed, 0);

  console.log("PASS rollout flow conserves three received units and reports $14 intake market, 43.333 days held, idempotent recovery, and market fail-open");
} finally {
  await pool.query(`DELETE FROM inventory_fifo_revision_allocations WHERE revision_id IN
    (SELECT revision.id FROM inventory_fifo_revisions revision JOIN inventory_fifo_lines line ON line.id=revision.line_id WHERE line.seller_key=$1)`, [seller]);
  await pool.query(`UPDATE inventory_fifo_lines SET current_revision_id=NULL WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_fifo_revisions WHERE line_id IN (SELECT id FROM inventory_fifo_lines WHERE seller_key=$1)`, [seller]);
  await pool.query(`DELETE FROM inventory_fifo_lines WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_fifo_replay_queue WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM seller_orders WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM seller_order_sync_runs WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_publication_receipt_links WHERE publication_item_id IN
    (SELECT item.id FROM inventory_publication_items item JOIN inventory_publications publication ON publication.id=item.publication_id WHERE publication.seller_key=$1)`, [seller]);
  await pool.query(`DELETE FROM inventory_publication_items WHERE publication_id IN (SELECT id FROM inventory_publications WHERE seller_key=$1)`, [seller]);
  await pool.query(`DELETE FROM inventory_publications WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_receipt_batch_links WHERE receipt_id IN (SELECT receipt_id FROM inventory_receipts WHERE request_id LIKE $1)`, [`${seller}%`]);
  await pool.query(`DELETE FROM inventory_receipts WHERE request_id LIKE $1`, [`${seller}%`]);
  await pool.query(`DELETE FROM inventory_pending_mutations WHERE request_id LIKE $1`, [`${seller}%`]);
  await pool.query(`DELETE FROM inventory_batch_intake_requests WHERE request_id LIKE $1`, [`${seller}%`]);
  await pool.query(`DELETE FROM inventory_batches WHERE source_request_id LIKE $1`, [`${seller}%`]);
  await pool.query(`DELETE FROM inventory_opening_balance_items WHERE run_id IN (SELECT id FROM inventory_opening_balance_runs WHERE seller_key=$1)`, [seller]);
  await pool.query(`DELETE FROM inventory_opening_balance_runs WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_observation_differences WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_complete_observation_items WHERE observation_id IN (SELECT id FROM inventory_complete_observations WHERE seller_key=$1)`, [seller]);
  await pool.query(`DELETE FROM inventory_complete_observation_requests WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM inventory_complete_observations WHERE seller_key=$1`, [seller]);
  await pool.query(`DELETE FROM pending_inventory WHERE sku=$1`, [sku]);
  await pool.query(`DELETE FROM skus WHERE sku=$1`, [sku]);
  await pool.query(`DELETE FROM products WHERE product_id=$1`, [productId]);
  await pool.end();
}
