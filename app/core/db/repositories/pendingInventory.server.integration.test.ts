import assert from "node:assert/strict";
import { execute, getPool, query, queryOne } from "../database.server";
import {
  PendingInventoryConflictError,
  pendingInventoryRepository,
} from "./pendingInventory.server";
import {
  InventoryBatchRequestConflictError,
  inventoryBatchesRepository,
} from "./inventoryBatches.server";

const prefix = `receipt-test-${Date.now()}`;
const sku = 9_100_001;
const metadata = { productLineId: 1, setId: 2, productId: 3 };
const market = {
  marketValue: 4.25,
  observedAt: new Date("2026-09-07T14:06:00.000Z"),
  calculatedAt: new Date("2026-09-07T14:05:00.000Z"),
  provenance: "tcgplayer_price_points" as const,
};
let batchNumber: number | null = null;

try {
  await pendingInventoryRepository.mutate({
    type: "add",
    requestId: `${prefix}-first`,
    sku,
    quantity: 2,
    metadata,
    intakeAt: new Date("2026-09-07T14:00:00.000Z"),
    market,
  });
  const repeated = await pendingInventoryRepository.mutate({
    type: "add",
    requestId: `${prefix}-first`,
    sku,
    quantity: 2,
    metadata,
    intakeAt: new Date("2026-09-07T15:00:00.000Z"),
    market: { ...market, marketValue: 999 },
  });
  assert.equal(repeated.repeated, true);
  assert.equal(repeated.quantity, 2);

  await pendingInventoryRepository.mutate({
    type: "add",
    requestId: `${prefix}-second`,
    sku,
    quantity: 3,
    metadata,
    intakeAt: new Date("2026-09-07T16:00:00.000Z"),
    market: {
      marketValue: null,
      observedAt: null,
      calculatedAt: null,
      provenance: "tcgplayer_price_points_unavailable",
    },
  });

  let pending = await pendingInventoryRepository.findAll();
  assert.equal(pending.find((entry) => entry.sku === sku)?.quantity, 5);
  let receipts = (await pendingInventoryRepository.findReceipts()).filter(
    (receipt) => receipt.requestId.startsWith(prefix),
  );
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((receipt) => receipt.originalQuantity), [2, 3]);
  assert.equal(receipts[0].marketValue, 4.25);
  assert.equal(receipts[0].marketCalculatedAt?.toISOString(), market.calculatedAt.toISOString());
  assert.equal(receipts[1].marketValue, null);
  assert.equal(receipts[0].sellerKey, null);
  await assert.rejects(
    execute(
      `UPDATE inventory_receipts SET market_value = 99 WHERE receipt_id = $1`,
      [receipts[0].receiptId],
    ),
    /receipt evidence is immutable/i,
  );
  await execute(
    `UPDATE inventory_receipts SET seller_key = 'seller-a' WHERE receipt_id = $1`,
    [receipts[0].receiptId],
  );
  await assert.rejects(
    execute(
      `UPDATE inventory_receipts SET seller_key = 'seller-b' WHERE receipt_id = $1`,
      [receipts[0].receiptId],
    ),
    /seller ownership cannot be reassigned/i,
  );

  await assert.rejects(
    pendingInventoryRepository.mutate({
      type: "add",
      requestId: `${prefix}-first`,
      sku,
      quantity: 2,
      metadata: { ...metadata, productId: 4 },
      intakeAt: new Date(),
      market,
    }),
    PendingInventoryConflictError,
  );

  await pendingInventoryRepository.mutate({
    type: "set",
    requestId: `${prefix}-correct`,
    sku,
    quantity: 4,
    expectedQuantity: 5,
    metadata,
    intakeAt: new Date(),
    market,
  });
  await assert.rejects(
    pendingInventoryRepository.mutate({
      type: "set",
      requestId: `${prefix}-stale`,
      sku,
      quantity: 2,
      expectedQuantity: 5,
      metadata,
      intakeAt: new Date(),
      market,
    }),
    PendingInventoryConflictError,
  );

  await Promise.all([
    pendingInventoryRepository.mutate({
      type: "add",
      requestId: `${prefix}-concurrent-a`,
      sku,
      quantity: 1,
      metadata,
      intakeAt: new Date(),
      market,
    }),
    pendingInventoryRepository.mutate({
      type: "add",
      requestId: `${prefix}-concurrent-b`,
      sku,
      quantity: 1,
      metadata,
      intakeAt: new Date(),
      market,
    }),
  ]);
  pending = await pendingInventoryRepository.findAll();
  assert.equal(pending.find((entry) => entry.sku === sku)?.quantity, 6);

  const batchRequestId = `${prefix}-batch`;
  const batch = await inventoryBatchesRepository.createFromPendingInventory(batchRequestId);
  assert.ok(batch);
  batchNumber = batch.batchNumber;
  const repeatedBatch =
    await inventoryBatchesRepository.createFromPendingInventory(batchRequestId);
  assert.equal(repeatedBatch?.batchNumber, batchNumber);
  assert.equal((await pendingInventoryRepository.findAll()).length, 0);

  const linked = await queryOne<{ quantity: number }>(
    `SELECT SUM(linked_quantity)::int AS quantity
    FROM inventory_receipt_batch_links
    WHERE batch_number = $1`,
    [batchNumber],
  );
  assert.equal(linked?.quantity, 6);

  await inventoryBatchesRepository.deleteBatch(batchNumber);
  await pendingInventoryRepository.mutate({
    type: "add",
    requestId: `${prefix}-after-delete`,
    sku,
    quantity: 1,
    metadata,
    intakeAt: new Date(),
    market,
  });
  await assert.rejects(
    inventoryBatchesRepository.createFromPendingInventory(batchRequestId),
    InventoryBatchRequestConflictError,
  );
  assert.equal((await pendingInventoryRepository.findAll())[0]?.quantity, 1);

  await pendingInventoryRepository.mutate({
    type: "clear",
    requestId: `${prefix}-clear`,
  });
  assert.equal((await pendingInventoryRepository.findAll()).length, 0);
  receipts = (await pendingInventoryRepository.findReceipts()).filter(
    (receipt) => receipt.requestId.startsWith(prefix),
  );
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.originalQuantity, 0), 8);

  const correctionTotal = await queryOne<{ quantity: number }>(
    `SELECT COALESCE(SUM(adjustment.quantity_delta), 0)::int AS quantity
    FROM inventory_receipt_adjustments adjustment
    JOIN inventory_pending_mutations mutation
      ON mutation.request_id = adjustment.mutation_request_id
    WHERE mutation.request_id LIKE $1`,
    [`${prefix}%`],
  );
  assert.equal(correctionTotal?.quantity, -2);

  console.log("PASS inventory receipts conserve pending quantity, requests, and batch history");
} finally {
  await execute(
    `DELETE FROM inventory_receipt_batch_links
    WHERE receipt_id IN (SELECT receipt_id FROM inventory_receipts WHERE request_id LIKE $1)`,
    [`${prefix}%`],
  );
  await execute(
    `DELETE FROM inventory_receipt_adjustments
    WHERE mutation_request_id LIKE $1`,
    [`${prefix}%`],
  );
  await execute(`DELETE FROM inventory_receipts WHERE request_id LIKE $1`, [`${prefix}%`]);
  await execute(`DELETE FROM inventory_pending_mutations WHERE request_id LIKE $1`, [`${prefix}%`]);
  await execute(`DELETE FROM inventory_batch_intake_requests WHERE request_id LIKE $1`, [`${prefix}%`]);
  if (batchNumber !== null) {
    await execute(`DELETE FROM inventory_batches WHERE batch_number = $1`, [batchNumber]);
  }
  await execute(`DELETE FROM pending_inventory WHERE sku = $1`, [sku]);
  await getPool().end();
}
