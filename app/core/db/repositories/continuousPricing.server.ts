import type { ServerPricingConfig } from "~/features/pricing/types/config";
import type {
  ContinuousPricingInventoryItem,
  ContinuousPricingStatus,
  UpsertContinuousPricingInventoryItem,
} from "~/features/continuous-pricing/types/continuousPricing";
import type { TcgPlayerListing } from "~/core/types/pricing";
import {
  asJson,
  createValuesPlaceholders,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type ContinuousPricingInventoryRow = ContinuousPricingInventoryItem;

const inventorySelect = `SELECT
  seller_key AS "sellerKey",
  sku,
  product_id AS "productId",
  product_line_id AS "productLineId",
  set_id AS "setId",
  product_line AS "productLine",
  set_name AS "setName",
  product_name AS "productName",
  condition,
  variant,
  quantity,
  current_price::float8 AS "currentPrice",
  in_stock AS "inStock",
  enabled,
  pause_reason AS "pauseReason",
  last_observed_at AS "lastObservedAt",
  last_priced_at AS "lastPricedAt",
  last_published_price::float8 AS "lastPublishedPrice",
  last_published_at AS "lastPublishedAt",
  next_price_at AS "nextPriceAt",
  last_batch_number AS "lastBatchNumber",
  consecutive_pricing_failures AS "consecutivePricingFailures",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
FROM continuous_pricing_inventory`;

function toOriginalRow(item: ContinuousPricingInventoryItem): TcgPlayerListing {
  return {
    "TCGplayer Id": String(item.sku),
    "Product Line": item.productLine,
    "Set Name": item.setName,
    Product: item.productName,
    "Sku Variant": item.variant,
    "Sku Condition": item.condition,
    "Sale Count": "",
    "Lowest Sale Price": "",
    "Highest Sale Price": "",
    "TCG Market Price": "",
    "Total Quantity": String(item.quantity),
    "Add to Quantity": "0",
    "TCG Marketplace Price":
      item.currentPrice === null ? "" : String(item.currentPrice),
    "Previous Price": "",
    "Suggested Price": "",
    "Percentile Used": "",
    "Historical Sales Velocity (Days)": "",
    "Estimated Time to Sell (Days)": "",
    "Sales Count for Historical Calculation": "",
    "Listings Count for Estimated Calculation": "",
    Warning: "",
    Error: "",
  };
}

export const continuousPricingRepository = {
  async shouldRefresh(
    sellerKey: string,
    refreshIntervalMinutes: number,
    executor?: Queryable,
  ): Promise<boolean> {
    const row = await queryOne<{ shouldRefresh: boolean }>(
      `SELECT NOT EXISTS (
        SELECT 1
        FROM continuous_pricing_refreshes
        WHERE seller_key = $1
          AND status = 'completed'
          AND completed_at >= NOW() - ($2 * INTERVAL '1 minute')
      ) AS "shouldRefresh"`,
      [sellerKey, refreshIntervalMinutes],
      executor,
    );
    return row?.shouldRefresh ?? true;
  },

  async upsertSnapshot(
    sellerKey: string,
    items: UpsertContinuousPricingInventoryItem[],
    observedAt = new Date(),
  ): Promise<void> {
    await withTransaction(async (client) => {
      const refresh = await queryOne<{ id: number }>(
        `INSERT INTO continuous_pricing_refreshes (
          seller_key,
          status,
          observed_count
        ) VALUES ($1, 'refreshing', $2)
        RETURNING id`,
        [sellerKey, items.length],
        client,
      );
      if (!refresh) {
        throw new Error("Could not create continuous inventory refresh.");
      }

      if (items.length > 0) {
        const placeholders = createValuesPlaceholders(items.length, 13);
        await execute(
          `INSERT INTO continuous_pricing_inventory (
            seller_key,
            sku,
            product_id,
            product_line_id,
            set_id,
            product_line,
            set_name,
            product_name,
            condition,
            variant,
            quantity,
            current_price,
            last_observed_at
          ) VALUES ${placeholders}
          ON CONFLICT (seller_key, sku) DO UPDATE SET
            product_id = EXCLUDED.product_id,
            product_line_id = EXCLUDED.product_line_id,
            set_id = EXCLUDED.set_id,
            product_line = EXCLUDED.product_line,
            set_name = EXCLUDED.set_name,
            product_name = EXCLUDED.product_name,
            condition = EXCLUDED.condition,
            variant = EXCLUDED.variant,
            quantity = EXCLUDED.quantity,
            current_price = EXCLUDED.current_price,
            in_stock = TRUE,
            last_observed_at = EXCLUDED.last_observed_at,
            updated_at = NOW()`,
          items.flatMap((item) => [
            sellerKey,
            item.sku,
            item.productId,
            item.productLineId,
            item.setId,
            item.productLine,
            item.setName,
            item.productName,
            item.condition,
            item.variant,
            item.quantity,
            item.currentPrice,
            observedAt,
          ]),
          client,
        );
      }

      await execute(
        `UPDATE continuous_pricing_inventory
        SET in_stock = FALSE,
            quantity = 0,
            updated_at = NOW()
        WHERE seller_key = $1
          AND last_observed_at < $2`,
        [sellerKey, observedAt],
        client,
      );
      await execute(
        `UPDATE continuous_pricing_refreshes
        SET status = 'completed',
            completed_at = NOW()
        WHERE id = $1`,
        [refresh.id],
        client,
      );
    });
  },

  async recordRefreshFailure(
    sellerKey: string,
    errorMessage: string,
    executor?: Queryable,
  ): Promise<void> {
    await execute(
      `INSERT INTO continuous_pricing_refreshes (
        seller_key,
        status,
        error_message,
        completed_at
      ) VALUES ($1, 'failed', $2, NOW())`,
      [sellerKey, errorMessage.slice(0, 1_000)],
      executor,
    );
  },

  async findAll(
    sellerKey: string,
    executor?: Queryable,
  ): Promise<ContinuousPricingInventoryItem[]> {
    return query<ContinuousPricingInventoryRow>(
      `${inventorySelect}
      WHERE seller_key = $1
      ORDER BY enabled DESC, in_stock DESC, next_price_at, sku`,
      [sellerKey],
      executor,
    );
  },

  async setEnabled(
    sellerKey: string,
    sku: number,
    enabled: boolean,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `UPDATE continuous_pricing_inventory
      SET enabled = $3,
          pause_reason = CASE WHEN $3 THEN NULL ELSE pause_reason END,
          consecutive_pricing_failures = CASE
            WHEN $3 THEN 0 ELSE consecutive_pricing_failures
          END,
          next_price_at = CASE WHEN $3 THEN LEAST(next_price_at, NOW()) ELSE next_price_at END,
          updated_at = NOW()
      WHERE seller_key = $1
        AND sku = $2`,
      [sellerKey, sku, enabled],
      executor,
    );
  },

  async scheduleDueBatch(input: {
    sellerKey: string;
    batchSize: number;
    minimumIntervalMinutes: number;
    pricingConfig: ServerPricingConfig;
  }): Promise<{ batchNumber: number; itemCount: number } | null> {
    return withTransaction(async (client) => {
      const dueItems = await query<ContinuousPricingInventoryRow>(
        `${inventorySelect}
        WHERE seller_key = $1
          AND enabled
          AND in_stock
          AND quantity > 0
          AND pause_reason IS NULL
          AND next_price_at <= NOW()
          AND NOT EXISTS (
            SELECT 1
            FROM inventory_publication_items publication_item
            JOIN inventory_publications publication
              ON publication.id = publication_item.publication_id
            WHERE publication.source_type = 'continuous'
              AND publication.seller_key = continuous_pricing_inventory.seller_key
              AND publication.status IN ('planned', 'staging', 'staged', 'publishing', 'ambiguous')
              AND publication_item.sku = continuous_pricing_inventory.sku
              AND publication_item.status IN ('planned', 'ambiguous')
          )
        ORDER BY next_price_at, sku
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
        [input.sellerKey, input.batchSize],
        client,
      );
      if (dueItems.length === 0) {
        return null;
      }

      const batch = await queryOne<{ batchNumber: number }>(
        `INSERT INTO inventory_batches (
          status,
          source_type,
          source_label
        ) VALUES ('queued', 'continuous', $1)
        RETURNING batch_number AS "batchNumber"`,
        [input.sellerKey],
        client,
      );
      if (!batch) {
        throw new Error("Could not create continuous pricing batch.");
      }

      const placeholders = createValuesPlaceholders(dueItems.length, 11);
      await execute(
        `INSERT INTO inventory_batch_items (
          batch_number,
          sku,
          total_quantity,
          add_to_quantity,
          current_price,
          product_line_id,
          set_id,
          product_id,
          original_row_json,
          created_at,
          updated_at
        ) VALUES ${placeholders}`,
        dueItems.flatMap((item) => [
          batch.batchNumber,
          item.sku,
          item.quantity,
          0,
          item.currentPrice,
          item.productLineId,
          item.setId,
          item.productId,
          asJson(toOriginalRow(item)),
          new Date(),
          new Date(),
        ]),
        client,
      );
      await execute(
        `INSERT INTO inventory_batch_pricing_jobs (
          batch_number,
          mode,
          status,
          config_json
        ) VALUES ($1, 'full', 'queued', $2::jsonb)`,
        [batch.batchNumber, asJson(input.pricingConfig)],
        client,
      );
      await execute(
        `UPDATE continuous_pricing_inventory
        SET last_batch_number = $2,
            next_price_at = NOW() + ($3 * INTERVAL '1 minute'),
            updated_at = NOW()
        WHERE seller_key = $1
          AND sku = ANY($4::int[])`,
        [
          input.sellerKey,
          batch.batchNumber,
          input.minimumIntervalMinutes,
          dueItems.map((item) => item.sku),
        ],
        client,
      );

      return {
        batchNumber: batch.batchNumber,
        itemCount: dueItems.length,
      };
    });
  },

  async recordBatchCompleted(
    batchNumber: number,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `UPDATE continuous_pricing_inventory inventory
      SET last_priced_at = result.priced_at,
          consecutive_pricing_failures = CASE
            WHEN result.result_status = 'successful' THEN 0
            ELSE consecutive_pricing_failures + 1
          END,
          pause_reason = CASE
            WHEN result.result_status <> 'successful'
              AND consecutive_pricing_failures + 1 >= 3
            THEN 'Repeated pricing failures require review.'
            ELSE pause_reason
          END,
          updated_at = NOW()
      FROM inventory_batch_results result
      WHERE inventory.last_batch_number = $1
        AND result.batch_number = $1
        AND result.sku = inventory.sku`,
      [batchNumber],
      executor,
    );
  },

  async recordPublishedPrices(
    sellerKey: string,
    items: Array<{ sku: number; price: number }>,
    executor?: Queryable,
  ): Promise<void> {
    for (const item of items) {
      await execute(
        `UPDATE continuous_pricing_inventory
        SET current_price = $3,
            last_published_price = $3,
            last_published_at = NOW(),
            updated_at = NOW()
        WHERE seller_key = $1
          AND sku = $2`,
        [sellerKey, item.sku, item.price],
        executor,
      );
    }
  },

  async pauseAmbiguousSkus(
    sellerKey: string,
    skus: number[],
    executor?: Queryable,
  ): Promise<number> {
    if (skus.length === 0) {
      return 0;
    }
    return execute(
      `UPDATE continuous_pricing_inventory
      SET pause_reason = 'Ambiguous publication outcome requires reconciliation.',
          updated_at = NOW()
      WHERE seller_key = $1
        AND sku = ANY($2::int[])`,
      [sellerKey, skus],
      executor,
    );
  },

  async getStatus(
    sellerKey: string,
    settings: ContinuousPricingStatus["settings"],
    executor?: Queryable,
  ): Promise<ContinuousPricingStatus> {
    const counts = await queryOne<{
      inventoryCount: number;
      enabledInStockCount: number;
      dueCount: number;
      oldestDueAt: Date | null;
    }>(
      `SELECT
        COUNT(*)::INTEGER AS "inventoryCount",
        COUNT(*) FILTER (WHERE enabled AND in_stock)::INTEGER AS "enabledInStockCount",
        COUNT(*) FILTER (
          WHERE enabled
            AND in_stock
            AND pause_reason IS NULL
            AND next_price_at <= NOW()
        )::INTEGER AS "dueCount",
        MIN(next_price_at) FILTER (
          WHERE enabled
            AND in_stock
            AND pause_reason IS NULL
            AND next_price_at <= NOW()
        ) AS "oldestDueAt"
      FROM continuous_pricing_inventory
      WHERE seller_key = $1`,
      [sellerKey],
      executor,
    );
    const refresh = await queryOne<{
      status: ContinuousPricingStatus["lastRefreshStatus"];
      errorMessage: string | null;
      completedAt: Date | null;
      startedAt: Date;
    }>(
      `SELECT
        status,
        error_message AS "errorMessage",
        completed_at AS "completedAt",
        started_at AS "startedAt"
      FROM continuous_pricing_refreshes
      WHERE seller_key = $1
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
      [sellerKey],
      executor,
    );

    return {
      settings,
      inventoryCount: counts?.inventoryCount ?? 0,
      enabledInStockCount: counts?.enabledInStockCount ?? 0,
      dueCount: counts?.dueCount ?? 0,
      oldestDueAt: counts?.oldestDueAt ?? null,
      lastRefreshAt: refresh?.completedAt ?? refresh?.startedAt ?? null,
      lastRefreshStatus: refresh?.status ?? null,
      lastRefreshError: refresh?.errorMessage ?? null,
    };
  },
};
