import type { ServerPricingConfig } from "~/features/pricing/types/config";
import type {
  ContinuousPricingInventoryItem,
  ContinuousPricingInventoryPage,
  ContinuousPricingInventoryState,
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
import { PRICING_JOB_PRIORITIES } from "./inventoryBatchPricingJobs.server";

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

const schedulableInventoryWhere = `seller_key = $1
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
      AND publication.status IN (
        'planned',
        'staging',
        'staged',
        'publishing',
        'ambiguous'
      )
      AND publication_item.sku = continuous_pricing_inventory.sku
      AND publication_item.status IN ('planned', 'ambiguous')
  )`;

const priorityDueWhere = `(
  last_priced_at IS NULL
  OR consecutive_pricing_failures > 0
)`;

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
        const placeholders = createValuesPlaceholders(items.length, 14);
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
            in_stock,
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
            in_stock = EXCLUDED.in_stock,
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
            item.quantity > 0,
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

  async findPage(
    input: {
      sellerKey: string;
      search: string;
      state: ContinuousPricingInventoryState;
      page: number;
      pageSize: number;
    },
    executor?: Queryable,
  ): Promise<ContinuousPricingInventoryPage> {
    const stateWhere: Record<ContinuousPricingInventoryState, string> = {
      all: "TRUE",
      enabled: "enabled AND pause_reason IS NULL",
      paused: "NOT enabled",
      needs_review: "pause_reason IS NOT NULL",
      in_stock: "in_stock AND quantity > 0",
      out_of_stock: "NOT in_stock OR quantity <= 0",
      due: `enabled
        AND in_stock
        AND quantity > 0
        AND pause_reason IS NULL
        AND next_price_at <= NOW()`,
    };
    const search = input.search.trim();
    const requestedPage = Math.max(1, Math.floor(input.page));
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)));
    const where = `seller_key = $1
      AND (
        $2 = ''
        OR sku::text = $2
        OR product_name ILIKE '%' || $2 || '%'
        OR set_name ILIKE '%' || $2 || '%'
        OR condition ILIKE '%' || $2 || '%'
        OR product_line ILIKE '%' || $2 || '%'
      )
      AND (${stateWhere[input.state]})`;
    const parameters = [input.sellerKey, search];
    const count = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::INTEGER AS total
      FROM continuous_pricing_inventory
      WHERE ${where}`,
      parameters,
      executor,
    );
    const total = count?.total ?? 0;
    const maximumPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, maximumPage);
    const offset = (page - 1) * pageSize;
    const items = await query<ContinuousPricingInventoryRow>(
      `${inventorySelect}
      WHERE ${where}
      ORDER BY enabled DESC, in_stock DESC, next_price_at, sku
      LIMIT $3 OFFSET $4`,
      [...parameters, pageSize, offset],
      executor,
    );

    return {
      items,
      total,
      page,
      pageSize,
    };
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
  }): Promise<
    | {
        status: "scheduled";
        batchNumber: number;
        itemCount: number;
        priority: number;
      }
    | { status: "backlogged" }
    | null
  > {
    return withTransaction(async (client) => {
      await query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`continuous-pricing:${input.sellerKey}`],
        client,
      );

      const priorityDue = await queryOne<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1
          FROM continuous_pricing_inventory
          WHERE ${schedulableInventoryWhere}
            AND ${priorityDueWhere}
        ) AS exists`,
        [input.sellerKey],
        client,
      );
      const schedulePriority = priorityDue?.exists
        ? PRICING_JOB_PRIORITIES.continuousPriority
        : PRICING_JOB_PRIORITIES.continuousRoutine;
      const queuedAtPriority = await queryOne<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1
          FROM inventory_batch_pricing_jobs job
          JOIN inventory_batches batch
            ON batch.batch_number = job.batch_number
          WHERE job.status = 'queued'
            AND job.priority = $1
            AND batch.source_type = 'continuous'
        ) AS exists`,
        [schedulePriority],
        client,
      );
      if (queuedAtPriority?.exists) {
        return { status: "backlogged" };
      }

      const dueItems = await query<ContinuousPricingInventoryRow>(
        `${inventorySelect}
        WHERE ${schedulableInventoryWhere}
          ${priorityDue?.exists ? `AND ${priorityDueWhere}` : ""}
        ORDER BY
          CASE WHEN ${priorityDueWhere} THEN 0 ELSE 1 END,
          next_price_at,
          sku
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
          priority,
          mode,
          status,
          config_json
        ) VALUES ($1, $2, 'full', 'queued', $3::jsonb)`,
        [batch.batchNumber, schedulePriority, asJson(input.pricingConfig)],
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
        status: "scheduled" as const,
        batchNumber: batch.batchNumber,
        itemCount: dueItems.length,
        priority: schedulePriority,
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
          next_price_at = CASE
            WHEN result.result_status <> 'successful'
              AND cardinality(result.error_messages) > 0
              AND consecutive_pricing_failures + 1 < 3
            THEN LEAST(next_price_at, NOW() + INTERVAL '15 minutes')
            ELSE next_price_at
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

  async pauseProductDetailMismatchSkus(
    sellerKey: string,
    skus: number[],
    executor?: Queryable,
  ): Promise<number> {
    if (skus.length === 0) {
      return 0;
    }
    return execute(
      `UPDATE continuous_pricing_inventory
      SET pause_reason =
            'Seller product details do not match this SKU; review required.',
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
      inStockSkuCount: number;
      availableUnitCount: number;
      currentInventoryValue: number;
      pricedInStockSkuCount: number;
      publishedInStockSkuCount: number;
      needsReviewCount: number;
      outOfStockSkuCount: number;
      enabledInStockCount: number;
      dueCount: number;
      oldestDueAt: Date | null;
    }>(
      `SELECT
        COUNT(*)::INTEGER AS "inventoryCount",
        COUNT(*) FILTER (
          WHERE in_stock AND quantity > 0
        )::INTEGER AS "inStockSkuCount",
        COALESCE(SUM(quantity) FILTER (
          WHERE in_stock AND quantity > 0
        ), 0)::INTEGER AS "availableUnitCount",
        COALESCE(SUM(quantity * current_price) FILTER (
          WHERE in_stock AND quantity > 0 AND current_price IS NOT NULL
        ), 0)::FLOAT8 AS "currentInventoryValue",
        COUNT(*) FILTER (
          WHERE in_stock AND quantity > 0 AND last_priced_at IS NOT NULL
        )::INTEGER AS "pricedInStockSkuCount",
        COUNT(*) FILTER (
          WHERE in_stock AND quantity > 0 AND last_published_at IS NOT NULL
        )::INTEGER AS "publishedInStockSkuCount",
        COUNT(*) FILTER (
          WHERE pause_reason IS NOT NULL
        )::INTEGER AS "needsReviewCount",
        COUNT(*) FILTER (
          WHERE NOT in_stock OR quantity <= 0
        )::INTEGER AS "outOfStockSkuCount",
        COUNT(*) FILTER (
          WHERE enabled AND in_stock AND quantity > 0
        )::INTEGER AS "enabledInStockCount",
        COUNT(*) FILTER (
          WHERE enabled
            AND in_stock
            AND quantity > 0
            AND pause_reason IS NULL
            AND next_price_at <= NOW()
        )::INTEGER AS "dueCount",
        MIN(next_price_at) FILTER (
          WHERE enabled
            AND in_stock
            AND quantity > 0
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
      inStockSkuCount: counts?.inStockSkuCount ?? 0,
      availableUnitCount: counts?.availableUnitCount ?? 0,
      currentInventoryValue: counts?.currentInventoryValue ?? 0,
      pricedInStockSkuCount: counts?.pricedInStockSkuCount ?? 0,
      publishedInStockSkuCount: counts?.publishedInStockSkuCount ?? 0,
      needsReviewCount: counts?.needsReviewCount ?? 0,
      outOfStockSkuCount: counts?.outOfStockSkuCount ?? 0,
      enabledInStockCount: counts?.enabledInStockCount ?? 0,
      dueCount: counts?.dueCount ?? 0,
      oldestDueAt: counts?.oldestDueAt ?? null,
      lastRefreshAt: refresh?.completedAt ?? refresh?.startedAt ?? null,
      lastRefreshStatus: refresh?.status ?? null,
      lastRefreshError: refresh?.errorMessage ?? null,
    };
  },
};
