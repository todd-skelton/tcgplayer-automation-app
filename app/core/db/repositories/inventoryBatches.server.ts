import type { ProcessingSummary } from "~/core/types/pricing";
import type {
  InventoryBatch,
  InventoryBatchItem,
  InventoryBatchItemsScope,
  InventoryBatchResult,
  InventoryBatchResultsScope,
  SaveInventoryBatchResultsParams,
  InventoryBatchStatus,
} from "~/features/pending-inventory/types/inventoryBatch";
import {
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";
import { inventoryBatchPricingJobsRepository } from "./inventoryBatchPricingJobs.server";

type InventoryBatchRow = Omit<InventoryBatch, "latestJob">;
type InventoryBatchItemRow = InventoryBatchItem;
type InventoryBatchResultRow = InventoryBatchResult;

const batchSelect = `SELECT
  b.batch_number AS "batchNumber",
  b.status,
  b.created_at AS "createdAt",
  b.updated_at AS "updatedAt",
  b.last_priced_at AS "lastPricedAt",
  b.summary_json AS "summary",
  b.successful_count AS "successfulCount",
  b.manual_review_count AS "manualReviewCount",
  COUNT(i.sku)::int AS "itemCount"
FROM inventory_batches b
LEFT JOIN inventory_batch_items i
  ON i.batch_number = b.batch_number`;

const batchGroupBy = `GROUP BY
  b.batch_number,
  b.status,
  b.created_at,
  b.updated_at,
  b.last_priced_at,
  b.summary_json,
  b.successful_count,
  b.manual_review_count`;

async function attachLatestJobs(
  batches: InventoryBatchRow[],
  executor?: Queryable,
): Promise<InventoryBatch[]> {
  const jobsByBatch = await inventoryBatchPricingJobsRepository.findLatestByBatchNumbers(
    batches.map((batch) => batch.batchNumber),
    executor,
  );

  return batches.map((batch) => ({
    ...batch,
    latestJob: jobsByBatch.get(batch.batchNumber) ?? null,
  }));
}

async function refreshBatchCounts(
  batchNumber: number,
  summary: ProcessingSummary | null,
  executor?: Queryable,
): Promise<void> {
  await execute(
    `UPDATE inventory_batches
    SET status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM inventory_batch_results r
            WHERE r.batch_number = $1
          ) THEN 'priced'
          ELSE 'pending'
        END,
        updated_at = NOW(),
        last_priced_at = CASE
          WHEN $2::jsonb IS NULL THEN last_priced_at
          ELSE NOW()
        END,
        summary_json = COALESCE($2::jsonb, summary_json),
        successful_count = (
          SELECT COUNT(*)::int
          FROM inventory_batch_results r
          WHERE r.batch_number = $1
            AND r.result_status = 'successful'
        ),
        manual_review_count = (
          SELECT COUNT(*)::int
          FROM inventory_batch_results r
          WHERE r.batch_number = $1
            AND r.result_status = 'manual_review'
        )
    WHERE batch_number = $1`,
    [batchNumber, summary ? JSON.stringify(summary) : null],
    executor,
  );
}

export const inventoryBatchesRepository = {
  async findAll(executor?: Queryable): Promise<InventoryBatch[]> {
    const rows = await query<InventoryBatchRow>(
      `${batchSelect}
      ${batchGroupBy}
      ORDER BY b.batch_number DESC`,
      [],
      executor,
    );

    return attachLatestJobs(rows, executor);
  },

  async findByBatchNumber(
    batchNumber: number,
    executor?: Queryable,
  ): Promise<InventoryBatch | null> {
    const batch = await queryOne<InventoryBatchRow>(
      `${batchSelect}
      WHERE b.batch_number = $1
      ${batchGroupBy}`,
      [batchNumber],
      executor,
    );

    if (!batch) {
      return null;
    }

    const latestJob = await inventoryBatchPricingJobsRepository.findLatestByBatchNumber(
      batchNumber,
      executor,
    );

    return {
      ...batch,
      latestJob,
    };
  },

  async updateStatus(
    batchNumber: number,
    status: InventoryBatchStatus,
    executor?: Queryable,
  ): Promise<void> {
    await execute(
      `UPDATE inventory_batches
      SET status = $2,
          updated_at = NOW()
      WHERE batch_number = $1`,
      [batchNumber, status],
      executor,
    );
  },

  async createFromPendingInventory(): Promise<InventoryBatch | null> {
    return withTransaction(async (client) => {
      const pendingRows = await query<{ sku: number }>(
        `SELECT sku
        FROM pending_inventory
        ORDER BY created_at
        FOR UPDATE`,
        [],
        client,
      );

      if (pendingRows.length === 0) {
        return null;
      }

      const createdBatch = await queryOne<{ batchNumber: number }>(
        `INSERT INTO inventory_batches (status)
        VALUES ('pending')
        RETURNING batch_number AS "batchNumber"`,
        [],
        client,
      );

      if (!createdBatch) {
        throw new Error("Failed to create inventory batch");
      }

      await execute(
        `INSERT INTO inventory_batch_items (
          batch_number,
          sku,
          quantity,
          product_line_id,
          set_id,
          product_id,
          created_at,
          updated_at
        )
        SELECT
          $1,
          sku,
          quantity,
          product_line_id,
          set_id,
          product_id,
          created_at,
          updated_at
        FROM pending_inventory`,
        [createdBatch.batchNumber],
        client,
      );

      await execute(`DELETE FROM pending_inventory`, [], client);

      return inventoryBatchesRepository.findByBatchNumber(
        createdBatch.batchNumber,
        client,
      );
    });
  },

  async deleteBatch(
    batchNumber: number,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `DELETE FROM inventory_batches
      WHERE batch_number = $1`,
      [batchNumber],
      executor,
    );
  },

  async findItems(
    batchNumber: number,
    scope: InventoryBatchItemsScope = "all",
    executor?: Queryable,
  ): Promise<InventoryBatchItem[]> {
    const whereClause =
      scope === "errors"
        ? `AND i.sku > 0
          AND i.quantity > 0
          AND EXISTS (
            SELECT 1
            FROM inventory_batch_results r
            WHERE r.batch_number = i.batch_number
              AND r.sku = i.sku
              AND r.result_status <> 'successful'
          )`
        : "";

    return query<InventoryBatchItemRow>(
      `SELECT
        i.batch_number AS "batchNumber",
        i.sku,
        i.quantity,
        i.product_line_id AS "productLineId",
        i.set_id AS "setId",
        i.product_id AS "productId",
        i.created_at AS "createdAt",
        i.updated_at AS "updatedAt"
      FROM inventory_batch_items i
      WHERE i.batch_number = $1
      ${whereClause}
      ORDER BY i.created_at, i.sku`,
      [batchNumber],
      executor,
    );
  },

  async findResults(
    batchNumber: number,
    scope: InventoryBatchResultsScope,
    executor?: Queryable,
  ): Promise<InventoryBatchResult[]> {
    const resultStatusClause =
      scope === "manual-review"
        ? "r.result_status <> 'successful'"
        : "r.result_status = 'successful'";

    return query<InventoryBatchResultRow>(
      `SELECT
        r.batch_number AS "batchNumber",
        r.sku,
        r.result_status AS "resultStatus",
        r.row_json AS "row",
        r.error_messages AS "errorMessages",
        r.warning_messages AS "warningMessages",
        r.priced_at AS "pricedAt"
      FROM inventory_batch_results r
      WHERE r.batch_number = $1
        AND ${resultStatusClause}
      ORDER BY
        COALESCE(r.row_json->>'Product Line', ''),
        COALESCE(r.row_json->>'Set Name', ''),
        COALESCE(r.row_json->>'Product', ''),
        r.sku`,
      [batchNumber],
      executor,
    );
  },

  async saveResults(
    params: SaveInventoryBatchResultsParams,
  ): Promise<InventoryBatch> {
    return withTransaction(async (client) => {
      const batch = await inventoryBatchesRepository.findByBatchNumber(
        params.batchNumber,
        client,
      );

      if (!batch) {
        throw new Error(`Batch ${params.batchNumber} not found`);
      }

      if (params.mode === "full") {
        await execute(
          `DELETE FROM inventory_batch_results
          WHERE batch_number = $1`,
          [params.batchNumber],
          client,
        );
      }

      for (const row of params.rows) {
        await execute(
          `INSERT INTO inventory_batch_results (
            batch_number,
            sku,
            result_status,
            row_json,
            error_messages,
            warning_messages,
            priced_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6::text[], $7)
          ON CONFLICT (batch_number, sku) DO UPDATE SET
            result_status = EXCLUDED.result_status,
            row_json = EXCLUDED.row_json,
            error_messages = EXCLUDED.error_messages,
            warning_messages = EXCLUDED.warning_messages,
            priced_at = EXCLUDED.priced_at`,
          [
            params.batchNumber,
            row.sku,
            row.resultStatus,
            JSON.stringify(row.row),
            row.errorMessages,
            row.warningMessages,
            row.pricedAt,
          ],
          client,
        );
      }

      await refreshBatchCounts(params.batchNumber, params.summary, client);

      const updatedBatch = await inventoryBatchesRepository.findByBatchNumber(
        params.batchNumber,
        client,
      );

      if (!updatedBatch) {
        throw new Error(`Batch ${params.batchNumber} could not be reloaded`);
      }

      return updatedBatch;
    });
  },
};

