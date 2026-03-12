import type { PendingInventoryEntry } from "~/features/pending-inventory/types/pendingInventory";
import { execute, query, type Queryable } from "../database.server";

type PendingInventoryRow = PendingInventoryEntry;

export const pendingInventoryRepository = {
  async findAll(executor?: Queryable): Promise<PendingInventoryEntry[]> {
    return query<PendingInventoryRow>(
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

  async clearAll(executor?: Queryable): Promise<number> {
    return execute(`DELETE FROM pending_inventory`, [], executor);
  },

  async removeBySku(sku: number, executor?: Queryable): Promise<number> {
    return execute(
      `DELETE FROM pending_inventory WHERE sku = $1`,
      [sku],
      executor,
    );
  },

  async upsert(
    entry: PendingInventoryEntry,
    executor?: Queryable,
  ): Promise<void> {
    await execute(
      `INSERT INTO pending_inventory (
        sku,
        quantity,
        product_line_id,
        set_id,
        product_id,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (sku) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        product_line_id = EXCLUDED.product_line_id,
        set_id = EXCLUDED.set_id,
        product_id = EXCLUDED.product_id,
        updated_at = EXCLUDED.updated_at`,
      [
        entry.sku,
        entry.quantity,
        entry.productLineId,
        entry.setId,
        entry.productId,
        entry.createdAt,
        entry.updatedAt,
      ],
      executor,
    );
  },

  async updateSetIdByProduct(
    productId: number,
    productLineId: number,
    setId: number,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `UPDATE pending_inventory
      SET set_id = $1,
          updated_at = NOW()
      WHERE product_id = $2 AND product_line_id = $3`,
      [setId, productId, productLineId],
      executor,
    );
  },
};
