import assert from "node:assert/strict";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || process.env.DATABASE_URL !== testUrl) throw new Error("Matching TEST_DATABASE_URL and DATABASE_URL are required.");
if (!new URL(testUrl).pathname.replace(/^\/+/, "").startsWith("tcgplayer_strategy_test_")) {
  throw new Error("Estimated purchase cost integration tests require a disposable tcgplayer_strategy_test_* database.");
}
const { execute, getPool, query, queryOne } = await import("~/core/db/database.server");
const { inventoryEconomicsRepository } = await import("~/core/db/repositories/inventoryEconomics.server");
const { recordEstimatedPurchaseCosts } = await import("./estimatedPurchaseCosts.server");
const prefix = `estimated-${Date.now()}`;
const sellerKey = `${prefix}-seller`;
const sku = 9_000_000 + Date.now() % 999_999;

async function seedBatch(label: string, lots: Array<{ quantity: number; market: number | null; intakeAt: string }>) {
  const batch = await queryOne<{ id: number }>(`INSERT INTO inventory_batches (status,source_type,source_label)
    VALUES ('pending','pending_inventory',$1) RETURNING batch_number AS id`, [`${prefix}-${label}`]);
  assert.ok(batch);
  const receiptIds: number[] = [];
  for (const [offset, lot] of lots.entries()) {
    const requestId = `${prefix}-${label}-${offset}`;
    const lotSku = sku + receiptIds.length + (label.length * 100);
    await execute(`INSERT INTO inventory_pending_mutations
      (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
      VALUES ($1,'add',$2,$3,1,1,1,$3,$3)`, [requestId, lotSku, lot.quantity]);
    const receipt = await queryOne<{ id: number }>(`INSERT INTO inventory_receipts
      (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,market_value,market_provenance,intake_at)
      VALUES ($1,$2,$3,1,1,1,$4,$5,$6,$7) RETURNING receipt_id AS id`,
      [requestId, lotSku, lot.quantity, sellerKey, lot.market, lot.market === null ? "test_unavailable" : "test", lot.intakeAt]);
    assert.ok(receipt);
    await execute(`INSERT INTO inventory_receipt_batch_links (receipt_id,batch_number,linked_quantity) VALUES ($1,$2,$3)`,
      [receipt.id, batch.id, lot.quantity]);
    receiptIds.push(receipt.id);
  }
  return { batchNumber: batch.id, receiptIds };
}

try {
  const priced = await seedBatch("priced", [
    { quantity: 2, market: 10, intakeAt: "2026-09-02T12:00:00Z" },
    { quantity: 3, market: 0.25, intakeAt: "2026-09-01T12:00:00Z" },
  ]);
  const unquoted = await seedBatch("unquoted", [{ quantity: 1, market: null, intakeAt: "2026-09-03T12:00:00Z" }]);
  const entered = await seedBatch("entered", [{ quantity: 1, market: 4, intakeAt: "2026-09-04T12:00:00Z" }]);
  await inventoryEconomicsRepository.recordPurchaseCost({ requestId: `${prefix}-entered`, sellerKey,
    purchaseReference: `${prefix}-invoice`, currency: "USD", totalAmountCents: 123, provenance: "actual",
    source: "intake", allocationRule: "quantity", batchNumbers: [entered.batchNumber] });

  const floored = await seedBatch("floored", [
    { quantity: 1, market: 4, intakeAt: "2026-09-05T12:00:00Z" },
    { quantity: 2, market: 0.1, intakeAt: "2026-09-05T12:00:00Z" },
  ]);
  const flooredV1 = await inventoryEconomicsRepository.recordPurchaseCost({
    requestId: `estimated-purchase-cost:market-rate-v1:batch-${floored.batchNumber}`, sellerKey,
    purchaseReference: `estimated:batch-${floored.batchNumber}`, currency: "USD", totalAmountCents: 270,
    provenance: "estimated", source: "intake", allocationRule: "explicit", batchNumbers: [floored.batchNumber],
    purchasedAt: "2026-09-05",
    explicitAllocations: [{ receiptId: floored.receiptIds[0], amountCents: 270 }, { receiptId: floored.receiptIds[1], amountCents: 0 }] });
  const steady = await seedBatch("steady", [{ quantity: 1, market: 4, intakeAt: "2026-09-06T12:00:00Z" }]);
  await inventoryEconomicsRepository.recordPurchaseCost({
    requestId: `estimated-purchase-cost:market-rate-v1:batch-${steady.batchNumber}`, sellerKey,
    purchaseReference: `estimated:batch-${steady.batchNumber}`, currency: "USD", totalAmountCents: 270,
    provenance: "estimated", source: "intake", allocationRule: "explicit", batchNumbers: [steady.batchNumber],
    purchasedAt: "2026-09-06", explicitAllocations: [{ receiptId: steady.receiptIds[0], amountCents: 270 }] });

  const batchNumbers = [priced.batchNumber, unquoted.batchNumber, entered.batchNumber, floored.batchNumber, steady.batchNumber];
  const first = await recordEstimatedPurchaseCosts(sellerKey, { batchNumbers });
  assert.deepEqual(first.recorded.map((entry) => [entry.batchNumber, entry.totalAmountCents, entry.unitCount, entry.correctsEntryId ?? null]),
    [[priced.batchNumber, 1407, 5, null], [floored.batchNumber, 226, 3, flooredV1.entryId]]);
  assert.deepEqual(first.repeated, []);
  assert.deepEqual(first.unchanged, [steady.batchNumber]);
  assert.deepEqual(first.marketUnavailable, [{ batchNumber: unquoted.batchNumber, receiptIds: unquoted.receiptIds }]);
  const correction = await query<{ receiptId: number; amountCents: number }>(
    `SELECT receipt_id AS "receiptId",allocated_amount_cents::int AS "amountCents" FROM inventory_purchase_cost_allocations
     WHERE entry_id=$1 ORDER BY receipt_id`, [first.recorded[1].entryId]);
  assert.deepEqual(correction, [{ receiptId: floored.receiptIds[0], amountCents: 270 }, { receiptId: floored.receiptIds[1], amountCents: -44 }]);
  const history = (await inventoryEconomicsRepository.listPurchaseCosts(sellerKey))
    .filter((entry) => entry.purchaseReference === `estimated:batch-${floored.batchNumber}`);
  assert.deepEqual(history.map((entry) => [entry.version, entry.isCurrent, entry.totalAmountCents, entry.correctionReason ?? null]),
    [[2, true, 226, "Re-estimated under rule market-rate-v2"], [1, false, 270, null]]);

  const entry = await queryOne<{ purchaseReference: string; provenance: string; allocationRule: string; purchasedAt: string | null; totalAmountCents: number }>(
    `SELECT series.purchase_reference AS "purchaseReference",entry.provenance,entry.allocation_rule AS "allocationRule",
       entry.purchased_at::text AS "purchasedAt",entry.total_amount_cents::int AS "totalAmountCents"
     FROM inventory_purchase_cost_entries entry
     JOIN inventory_purchase_cost_series series ON series.id=entry.series_id
     WHERE entry.id=$1`, [first.recorded[0].entryId]);
  assert.deepEqual(entry, { purchaseReference: `estimated:batch-${priced.batchNumber}`, provenance: "estimated",
    allocationRule: "explicit", purchasedAt: "2026-09-01", totalAmountCents: 1407 });
  const allocations = await query<{ receiptId: number; amountCents: number }>(
    `SELECT receipt_id AS "receiptId",allocated_amount_cents::int AS "amountCents" FROM inventory_purchase_cost_allocations
     WHERE entry_id=$1 ORDER BY receipt_id`, [first.recorded[0].entryId]);
  assert.deepEqual(allocations, [
    { receiptId: priced.receiptIds[0], amountCents: 1440 },
    { receiptId: priced.receiptIds[1], amountCents: -33 },
  ]);

  const second = await recordEstimatedPurchaseCosts(sellerKey, { batchNumbers });
  assert.deepEqual(second.recorded, []);
  assert.deepEqual(second.repeated, [priced.batchNumber, floored.batchNumber]);
  assert.deepEqual(second.unchanged, [steady.batchNumber]);
  assert.deepEqual(second.marketUnavailable.map((batch) => batch.batchNumber), [unquoted.batchNumber]);
  const enteredEntries = await query<{ provenance: string }>(
    `SELECT entry.provenance FROM inventory_purchase_cost_entries entry
     JOIN inventory_purchase_cost_allocations allocation ON allocation.entry_id=entry.id
     WHERE allocation.receipt_id=$1`, [entered.receiptIds[0]]);
  assert.deepEqual(enteredEntries, [{ provenance: "actual" }]);
  console.log("PASS estimated purchase costs are recorded once, corrected when the rule changes them, and never replace entered cost");
} finally {
  await getPool().end();
}