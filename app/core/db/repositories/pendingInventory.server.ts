import type { PendingInventoryEntry } from "~/features/pending-inventory/types/pendingInventory";
import { reducePendingReceipts } from "~/features/inventory-history/domain/receiptBalances";
import type {
  InventoryReceipt,
  PendingInventoryMutation,
  PendingInventoryMutationResult,
} from "~/features/inventory-history/types/inventoryReceipt";
import {
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type StoredMutation = {
  requestId: string;
  mutationType: PendingInventoryMutation["type"];
  sku: number | null;
  requestedQuantity: number | null;
  expectedQuantity: number | null;
  productLineId: number | null;
  setId: number | null;
  productId: number | null;
  quantityDelta: number;
  resultingQuantity: number;
};

type PendingReceiptBalance = {
  receiptId: number;
  sku: number;
  quantity: number;
};

export class PendingInventoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingInventoryConflictError";
  }
}

const mutationSelect = `SELECT
  request_id AS "requestId",
  mutation_type AS "mutationType",
  sku,
  requested_quantity AS "requestedQuantity",
  expected_quantity AS "expectedQuantity",
  product_line_id AS "productLineId",
  set_id AS "setId",
  product_id AS "productId",
  quantity_delta AS "quantityDelta",
  resulting_quantity AS "resultingQuantity"
FROM inventory_pending_mutations`;

const pendingReceiptBalanceQuery = `WITH adjusted_receipts AS (
  SELECT
    receipt.receipt_id AS "receiptId",
    receipt.sku,
    receipt.intake_at AS "intakeAt",
    receipt.recorded_at AS "recordedAt",
    receipt.original_quantity
      + COALESCE(SUM(adjustment.quantity_delta), 0)::integer AS adjusted_quantity
  FROM inventory_receipts receipt
  JOIN pending_inventory pending ON pending.sku = receipt.sku
  LEFT JOIN inventory_receipt_adjustments adjustment
    ON adjustment.receipt_id = receipt.receipt_id
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_receipt_batch_links linked
    WHERE linked.receipt_id = receipt.receipt_id
  )
  GROUP BY receipt.receipt_id
), receipt_balances AS (
  SELECT
    receipt."receiptId",
    receipt.sku,
    receipt."intakeAt",
    receipt."recordedAt",
    receipt.adjusted_quantity
      - COALESCE(SUM(link.linked_quantity), 0)::integer AS quantity
  FROM adjusted_receipts receipt
  LEFT JOIN inventory_receipt_batch_links link
    ON link.receipt_id = receipt."receiptId"
  GROUP BY
    receipt."receiptId",
    receipt.sku,
    receipt."intakeAt",
    receipt."recordedAt",
    receipt.adjusted_quantity
)
SELECT "receiptId", sku, quantity, "intakeAt", "recordedAt"
FROM receipt_balances
WHERE quantity > 0`;

function requestQuantity(mutation: PendingInventoryMutation): number | null {
  return mutation.type === "clear" ? null : mutation.quantity;
}

function requestExpectedQuantity(
  mutation: PendingInventoryMutation,
): number | null {
  return mutation.type === "set" ? mutation.expectedQuantity : null;
}

function assertSameRequest(
  stored: StoredMutation,
  mutation: PendingInventoryMutation,
): void {
  const sku = mutation.type === "clear" ? null : mutation.sku;
  const metadata = mutation.type === "clear" ? null : mutation.metadata;
  if (
    stored.mutationType !== mutation.type ||
    stored.sku !== sku ||
    stored.requestedQuantity !== requestQuantity(mutation) ||
    stored.expectedQuantity !== requestExpectedQuantity(mutation) ||
    stored.productLineId !== (metadata?.productLineId ?? null) ||
    stored.setId !== (metadata?.setId ?? null) ||
    stored.productId !== (metadata?.productId ?? null)
  ) {
    throw new PendingInventoryConflictError(
      `Request ID ${mutation.requestId} was already used for a different inventory mutation`,
    );
  }
}

async function lockInventory(executor: Queryable): Promise<void> {
  await execute(`SELECT pg_advisory_xact_lock(55, 0)`, [], executor);
}

async function findStoredMutation(
  requestId: string,
  executor: Queryable,
): Promise<StoredMutation | null> {
  return queryOne<StoredMutation>(
    `${mutationSelect} WHERE request_id = $1`,
    [requestId],
    executor,
  );
}

async function insertMutation(
  mutation: PendingInventoryMutation,
  quantityDelta: number,
  resultingQuantity: number,
  executor: Queryable,
): Promise<void> {
  await execute(
    `INSERT INTO inventory_pending_mutations (
      request_id,
      mutation_type,
      sku,
      requested_quantity,
      expected_quantity,
      product_line_id,
      set_id,
      product_id,
      quantity_delta,
      resulting_quantity
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      mutation.requestId,
      mutation.type,
      mutation.type === "clear" ? null : mutation.sku,
      requestQuantity(mutation),
      requestExpectedQuantity(mutation),
      mutation.type === "clear" ? null : mutation.metadata.productLineId,
      mutation.type === "clear" ? null : mutation.metadata.setId,
      mutation.type === "clear" ? null : mutation.metadata.productId,
      quantityDelta,
      resultingQuantity,
    ],
    executor,
  );
}

async function insertReceipt(
  mutation: Extract<PendingInventoryMutation, { type: "add" | "set" }>,
  quantity: number,
  executor: Queryable,
): Promise<void> {
  await execute(
    `INSERT INTO inventory_receipts (
      request_id,
      sku,
      original_quantity,
      product_line_id,
      set_id,
      product_id,
      intake_at,
      market_value,
      market_observed_at,
      market_calculated_at,
      market_provenance,
      source_evidence
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      mutation.requestId,
      mutation.sku,
      quantity,
      mutation.metadata.productLineId,
      mutation.metadata.setId,
      mutation.metadata.productId,
      mutation.intakeAt,
      mutation.market.marketValue,
      mutation.market.observedAt,
      mutation.market.calculatedAt,
      mutation.market.provenance,
      JSON.stringify({ source: "inventory_manager" }),
    ],
    executor,
  );
}

async function findPendingReceiptBalances(
  executor: Queryable,
  sku?: number,
): Promise<PendingReceiptBalance[]> {
  return query<PendingReceiptBalance>(
    `${pendingReceiptBalanceQuery}
    ${sku === undefined ? "" : "AND sku = $1"}
    ORDER BY "intakeAt" DESC NULLS LAST, "recordedAt" DESC, "receiptId" DESC`,
    sku === undefined ? [] : [sku],
    executor,
  );
}

async function applyRemoval(
  requestId: string,
  quantity: number,
  reason: "correction" | "clear",
  executor: Queryable,
  sku?: number,
): Promise<void> {
  const receipts = await findPendingReceiptBalances(executor, sku);
  const adjustments = reducePendingReceipts(receipts, quantity);

  for (const adjustment of adjustments) {
    await execute(
      `INSERT INTO inventory_receipt_adjustments (
        receipt_id,
        mutation_request_id,
        quantity_delta,
        reason
      ) VALUES ($1, $2, $3, $4)`,
      [adjustment.receiptId, requestId, adjustment.quantityDelta, reason],
      executor,
    );
  }
}

async function findPendingEntry(
  sku: number,
  executor: Queryable,
): Promise<PendingInventoryEntry | null> {
  return queryOne<PendingInventoryEntry>(
    `SELECT
      sku,
      quantity,
      product_line_id AS "productLineId",
      set_id AS "setId",
      product_id AS "productId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM pending_inventory
    WHERE sku = $1`,
    [sku],
    executor,
  );
}

function assertMatchingMetadata(
  existing: PendingInventoryEntry | null,
  mutation: Exclude<PendingInventoryMutation, { type: "clear" }>,
): void {
  if (
    existing &&
    (existing.productLineId !== mutation.metadata.productLineId ||
      existing.setId !== mutation.metadata.setId ||
      existing.productId !== mutation.metadata.productId)
  ) {
    throw new PendingInventoryConflictError(
      `SKU ${mutation.sku} already has different pending product metadata`,
    );
  }
}

export const pendingInventoryRepository = {
  async findAll(executor?: Queryable): Promise<PendingInventoryEntry[]> {
    return query<PendingInventoryEntry>(
      `SELECT
        sku,
        quantity,
        product_line_id AS "productLineId",
        set_id AS "setId",
        product_id AS "productId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM pending_inventory
      ORDER BY created_at DESC`,
      [],
      executor,
    );
  },

  async mutate(
    mutation: PendingInventoryMutation,
  ): Promise<PendingInventoryMutationResult> {
    return withTransaction(async (client) => {
      await lockInventory(client);

      const stored = await findStoredMutation(mutation.requestId, client);
      if (stored) {
        assertSameRequest(stored, mutation);
        return {
          requestId: stored.requestId,
          quantity: stored.resultingQuantity,
          quantityDelta: stored.quantityDelta,
          repeated: true,
        };
      }

      if (mutation.type === "clear") {
        const entries = await pendingInventoryRepository.findAll(client);
        const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
        await insertMutation(mutation, -total, 0, client);
        if (total > 0) {
          await applyRemoval(mutation.requestId, total, "clear", client);
        }
        await execute(`DELETE FROM pending_inventory`, [], client);
        return {
          requestId: mutation.requestId,
          quantity: 0,
          quantityDelta: -total,
          repeated: false,
        };
      }

      const existing = await findPendingEntry(mutation.sku, client);
      assertMatchingMetadata(existing, mutation);
      const current = existing?.quantity ?? 0;
      let delta: number;

      if (mutation.type === "add") {
        delta = mutation.quantity;
      } else if (mutation.type === "remove") {
        delta = -mutation.quantity;
      } else {
        if (current !== mutation.expectedQuantity) {
          throw new PendingInventoryConflictError(
            `Pending quantity changed from ${mutation.expectedQuantity} to ${current}; reload before replacing it`,
          );
        }
        delta = mutation.quantity - current;
      }

      const resultingQuantity = current + delta;
      if (resultingQuantity < 0) {
        throw new PendingInventoryConflictError(
          `Cannot remove ${Math.abs(delta)} from pending quantity ${current}`,
        );
      }

      await insertMutation(mutation, delta, resultingQuantity, client);

      if (delta > 0) {
        if (mutation.type === "remove") {
          throw new Error("Remove mutations cannot add inventory");
        }
        await insertReceipt(mutation, delta, client);
      } else if (delta < 0) {
        await applyRemoval(
          mutation.requestId,
          -delta,
          "correction",
          client,
          mutation.sku,
        );
      }

      if (resultingQuantity === 0) {
        await execute(`DELETE FROM pending_inventory WHERE sku = $1`, [mutation.sku], client);
      } else if (existing) {
        await execute(
          `UPDATE pending_inventory
          SET quantity = $2, updated_at = NOW()
          WHERE sku = $1`,
          [mutation.sku, resultingQuantity],
          client,
        );
      } else {
        await execute(
          `INSERT INTO pending_inventory (
            sku, quantity, product_line_id, set_id, product_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
          [
            mutation.sku,
            resultingQuantity,
            mutation.metadata.productLineId,
            mutation.metadata.setId,
            mutation.metadata.productId,
          ],
          client,
        );
      }

      return {
        requestId: mutation.requestId,
        quantity: resultingQuantity,
        quantityDelta: delta,
        repeated: false,
      };
    });
  },

  async findReceipts(executor?: Queryable): Promise<InventoryReceipt[]> {
    return query<InventoryReceipt>(
      `SELECT
        receipt_id AS "receiptId",
        request_id AS "requestId",
        sku,
        original_quantity AS "originalQuantity",
        product_line_id AS "productLineId",
        set_id AS "setId",
        product_id AS "productId",
        seller_key AS "sellerKey",
        intake_at AS "intakeAt",
        recorded_at AS "recordedAt",
        market_value::float8 AS "marketValue",
        market_observed_at AS "marketObservedAt",
        market_calculated_at AS "marketCalculatedAt",
        market_provenance AS "marketProvenance",
        source_evidence AS "sourceEvidence"
      FROM inventory_receipts
      ORDER BY receipt_id`,
      [],
      executor,
    );
  },

  async updateSetIdByProduct(
    productId: number,
    productLineId: number,
    setId: number,
    executor?: Queryable,
  ): Promise<number> {
    const updated = await execute(
      `UPDATE pending_inventory
      SET set_id = $1, updated_at = NOW()
      WHERE product_id = $2 AND product_line_id = $3`,
      [setId, productId, productLineId],
      executor,
    );
    await execute(
      `UPDATE inventory_receipts receipt
      SET set_id = $1
      WHERE receipt.product_id = $2
        AND receipt.product_line_id = $3
        AND NOT EXISTS (
          SELECT 1 FROM inventory_receipt_batch_links link
          WHERE link.receipt_id = receipt.receipt_id
        )`,
      [setId, productId, productLineId],
      executor,
    );
    return updated;
  },
};
