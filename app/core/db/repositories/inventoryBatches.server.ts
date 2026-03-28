import type { TcgPlayerListing } from "~/core/types/pricing";
import type {
  InventoryBatch,
  InventoryBatchItem,
  InventoryBatchItemsScope,
  InventoryBatchResult,
  InventoryBatchResultsScope,
  SaveInventoryBatchResultsParams,
  InventoryBatchStatus,
  InventoryBatchSummary,
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
type BatchSummarySourceRow = Pick<
  InventoryBatchResult,
  | "resultStatus"
  | "row"
  | "pricingDetails"
  | "errorMessages"
  | "warningMessages"
  | "pricedAt"
>;

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
  const jobsByBatch =
    await inventoryBatchPricingJobsRepository.findLatestByBatchNumbers(
      batches.map((batch) => batch.batchNumber),
      executor,
    );

  return batches.map((batch) => ({
    ...batch,
    latestJob: jobsByBatch.get(batch.batchNumber) ?? null,
  }));
}

function parseNumericValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getCombinedQuantity(
  row: TcgPlayerListing,
  quantity?: number,
  addToQuantity?: number,
): number {
  const totalQuantity = quantity ?? parseNumericValue(row["Total Quantity"]);
  const extraQuantity =
    addToQuantity ?? parseNumericValue(row["Add to Quantity"]);

  return totalQuantity + extraQuantity;
}

function computeMedian(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midIndex = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[midIndex - 1] + sorted[midIndex]) / 2
    : sorted[midIndex];
}

async function buildBatchSummary(
  batchNumber: number,
  totalRows: number,
  executor?: Queryable,
): Promise<InventoryBatchSummary | null> {
  const resultRows = await query<BatchSummarySourceRow>(
    `SELECT
      r.result_status AS "resultStatus",
      r.row_json AS "row",
      r.pricing_details_json AS "pricingDetails",
      r.error_messages AS "errorMessages",
      r.warning_messages AS "warningMessages",
      r.priced_at AS "pricedAt"
    FROM inventory_batch_results r
    WHERE r.batch_number = $1`,
    [batchNumber],
    executor,
  );

  if (resultRows.length === 0) {
    return null;
  }

  const successfulRows = resultRows.filter(
    (row) => row.resultStatus === "successful",
  );
  const manualReviewRows = resultRows.length - successfulRows.length;
  const totalsPercentiles: Record<string, number> = {};
  const totalsWithMarketPercentiles: Record<string, number> = {};
  const historicalPercentiles = new Map<string, number[]>();
  const marketAdjustedPercentiles = new Map<string, number[]>();
  const productLineBreakdown = new Map<
    string,
    { count: number; percentilesUsed: Set<number>; totalValue: number }
  >();

  let totalQuantity = 0;
  let totalAddQuantity = 0;
  let totalMarketPrice = 0;
  let totalLowPrice = 0;
  let totalMarketplacePrice = 0;
  let totalMarketWithMarket = 0;
  let quantityWithMarket = 0;

  for (const resultRow of successfulRows) {
    const { row, pricingDetails } = resultRow;
    const quantity =
      pricingDetails?.quantity ?? parseNumericValue(row["Total Quantity"]);
    const addToQuantity =
      pricingDetails?.addToQuantity ?? parseNumericValue(row["Add to Quantity"]);
    const combinedQuantity = getCombinedQuantity(row, quantity, addToQuantity);
    const tcgMarketPrice =
      pricingDetails?.tcgMarketPrice ??
      parseNumericValue(row["TCG Market Price"]);
    const lowestSalePrice =
      pricingDetails?.lowestSalePrice ??
      parseNumericValue(row["Lowest Sale Price"]);
    const marketplacePrice =
      pricingDetails?.marketplacePrice ??
      parseNumericValue(row["TCG Marketplace Price"]);
    const suggestedPrice =
      pricingDetails?.suggestedPrice ??
      parseNumericValue(row["Suggested Price"]);
    const productLineName = row["Product Line"] || "Unknown";

    totalQuantity += quantity;
    totalAddQuantity += addToQuantity;
    totalMarketPrice += tcgMarketPrice * combinedQuantity;
    totalLowPrice += lowestSalePrice * combinedQuantity;
    totalMarketplacePrice += marketplacePrice * combinedQuantity;

    if (tcgMarketPrice > 0) {
      totalMarketWithMarket += tcgMarketPrice * combinedQuantity;
      quantityWithMarket += combinedQuantity;
    }

    const productLineSummary = productLineBreakdown.get(productLineName) ?? {
      count: 0,
      percentilesUsed: new Set<number>(),
      totalValue: 0,
    };
    productLineSummary.count += 1;
    productLineSummary.totalValue += suggestedPrice * combinedQuantity;
    const percentileUsed =
      pricingDetails?.percentileUsed ??
      parseNumericValue(row["Percentile Used"]);
    if (percentileUsed > 0) {
      productLineSummary.percentilesUsed.add(percentileUsed);
    }
    productLineBreakdown.set(productLineName, productLineSummary);

    for (const percentile of pricingDetails?.percentiles ?? []) {
      const percentileKey = `${percentile.percentile}th`;
      totalsPercentiles[percentileKey] =
        (totalsPercentiles[percentileKey] ?? 0) +
        percentile.suggestedPrice * combinedQuantity;

      if (tcgMarketPrice > 0) {
        totalsWithMarketPercentiles[percentileKey] =
          (totalsWithMarketPercentiles[percentileKey] ?? 0) +
          percentile.suggestedPrice * combinedQuantity;
      }

      if (percentile.historicalSalesVelocityDays !== undefined) {
        const values = historicalPercentiles.get(percentileKey) ?? [];
        values.push(percentile.historicalSalesVelocityDays);
        historicalPercentiles.set(percentileKey, values);
      }

      if (percentile.estimatedTimeToSellDays !== undefined) {
        const values = marketAdjustedPercentiles.get(percentileKey) ?? [];
        values.push(percentile.estimatedTimeToSellDays);
        marketAdjustedPercentiles.set(percentileKey, values);
      }
    }
  }

  const summaryProductLines =
    productLineBreakdown.size > 0
      ? Object.fromEntries(
          [...productLineBreakdown.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([productLineName, data]) => [
              productLineName,
              {
                count: data.count,
                percentilesUsed: [...data.percentilesUsed].sort((a, b) => a - b),
                totalValue: data.totalValue,
              },
            ]),
        )
      : undefined;

  return {
    totalRows,
    processedRows: successfulRows.length,
    manualReviewRows,
    skippedRows: Math.max(totalRows - resultRows.length, 0),
    errorRows: resultRows.filter((row) => row.errorMessages.length > 0).length,
    warningRows: resultRows.filter((row) => row.warningMessages.length > 0)
      .length,
    successRate: totalRows > 0 ? (successfulRows.length / totalRows) * 100 : 0,
    generatedAt: new Date().toISOString(),
    fileName: `inventory-batch-${batchNumber}`,
    totalQuantity,
    totalAddQuantity,
    totals: {
      marketPrice: totalMarketPrice,
      lowPrice: totalLowPrice,
      marketplacePrice: totalMarketplacePrice,
      percentiles: totalsPercentiles,
    },
    totalsWithMarket: {
      marketPrice: totalMarketWithMarket,
      percentiles: totalsWithMarketPercentiles,
      quantityWithMarket,
    },
    medianDaysToSell: {
      historicalSalesVelocity: 0,
      percentiles: Object.fromEntries(
        [...historicalPercentiles.entries()]
          .map(([percentileKey, values]) => [
            percentileKey,
            computeMedian(values),
          ])
          .filter((entry): entry is [string, number] => entry[1] !== undefined),
      ),
      marketAdjustedPercentiles: Object.fromEntries(
        [...marketAdjustedPercentiles.entries()]
          .map(([percentileKey, values]) => [
            percentileKey,
            computeMedian(values),
          ])
          .filter((entry): entry is [string, number] => entry[1] !== undefined),
      ),
    },
    productLineBreakdown: summaryProductLines,
  };
}

async function refreshBatchCounts(
  batchNumber: number,
  executor?: Queryable,
): Promise<void> {
  const totalRows =
    (
      await queryOne<{ itemCount: number }>(
        `SELECT COUNT(*)::int AS "itemCount"
        FROM inventory_batch_items
        WHERE batch_number = $1`,
        [batchNumber],
        executor,
      )
    )?.itemCount ?? 0;
  const summary = await buildBatchSummary(batchNumber, totalRows, executor);

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
        last_priced_at = (
          SELECT MAX(r.priced_at)
          FROM inventory_batch_results r
          WHERE r.batch_number = $1
        ),
        summary_json = $2::jsonb,
        successful_count = $3,
        manual_review_count = $4
    WHERE batch_number = $1`,
    [
      batchNumber,
      summary ? JSON.stringify(summary) : null,
      summary?.processedRows ?? 0,
      summary?.manualReviewRows ?? 0,
    ],
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

    const latestJob =
      await inventoryBatchPricingJobsRepository.findLatestByBatchNumber(
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
        r.pricing_details_json AS "pricingDetails",
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
            pricing_details_json,
            error_messages,
            warning_messages,
            priced_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7::text[], $8)
          ON CONFLICT (batch_number, sku) DO UPDATE SET
            result_status = EXCLUDED.result_status,
            row_json = EXCLUDED.row_json,
            pricing_details_json = EXCLUDED.pricing_details_json,
            error_messages = EXCLUDED.error_messages,
            warning_messages = EXCLUDED.warning_messages,
            priced_at = EXCLUDED.priced_at`,
          [
            params.batchNumber,
            row.sku,
            row.resultStatus,
            JSON.stringify(row.row),
            row.pricingDetails ? JSON.stringify(row.pricingDetails) : null,
            row.errorMessages,
            row.warningMessages,
            row.pricedAt,
          ],
          client,
        );
      }

      await refreshBatchCounts(params.batchNumber, client);

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
