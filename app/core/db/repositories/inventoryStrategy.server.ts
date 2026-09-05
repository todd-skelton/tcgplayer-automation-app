import type {
  ForecastGradingRecord,
  InventoryStrategySnapshotItem,
} from "~/features/inventory-strategy/types/inventoryStrategy";
import type { SupplyAnalysisConfig } from "~/features/pricing/types/config";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import {
  asJson,
  execute,
  query,
  queryOne,
  type Queryable,
} from "../database.server";

type InventoryStrategySnapshotRow = InventoryStrategySnapshotItem;

// Scheduling and execution must apply the same source-data requirements.
export const reusablePricingCurveWhere = `
  curve.pricing_details_json->>'pricingModelVersion' = $2
  AND curve.pricing_details_json->'decision'->>'basis' = 'modeled'
  AND curve.pricing_details_json->'decision'->>'forecastStatus' <> 'unavailable'
  AND (
    SELECT job.config_json->'supplyAnalysis'
    FROM inventory_batch_pricing_jobs job
    WHERE job.batch_number = curve.batch_number
      AND job.created_at <= curve.priced_at
    ORDER BY job.created_at DESC, job.id DESC LIMIT 1
  ) = $4::jsonb
  AND COALESCE(
    (curve.pricing_details_json->>'marketDataAt')::timestamptz,
    curve.priced_at
  ) BETWEEN NOW() - ($3 * INTERVAL '1 minute') AND NOW()
  AND CASE
    WHEN jsonb_typeof(curve.pricing_details_json->'percentiles') = 'array'
    THEN jsonb_array_length(curve.pricing_details_json->'percentiles') > 0
    ELSE FALSE
  END`;

const snapshotSelect = `SELECT
        inventory.seller_key AS "sellerKey",
        inventory.sku,
        inventory.product_id AS "productId",
        inventory.product_line_id AS "productLineId",
        inventory.set_id AS "setId",
        inventory.product_line AS "productLine",
        inventory.set_name AS "setName",
        inventory.product_name AS "productName",
        inventory.condition,
        inventory.variant,
        inventory.quantity,
        inventory.current_price::float8 AS "currentPrice",
        inventory.market_price::float8 AS "marketPrice",
        inventory.pricing_eligible AS "pricingEligible",
        curve.pricing_details_json AS "pricingDetails",
        COALESCE(
          (curve.pricing_details_json->>'marketDataAt')::timestamptz,
          curve.priced_at
        ) AS "strategyPricedAt"
      FROM continuous_pricing_inventory inventory
      LEFT JOIN inventory_strategy_pricing_curves curve
        ON curve.seller_key = inventory.seller_key
        AND curve.sku = inventory.sku`;

export const inventoryStrategyRepository = {
  /** Changes whenever the in-stock inventory or any of its curves change. */
  async findSnapshotVersion(
    sellerKey: string,
    executor?: Queryable,
  ): Promise<string> {
    const row = await queryOne<{
      inventoryCount: number;
      inventoryUpdatedAt: Date | null;
      curveCount: number;
      curveUpdatedAt: Date | null;
    }>(
      `SELECT
        COUNT(*)::int AS "inventoryCount",
        MAX(inventory.updated_at) AS "inventoryUpdatedAt",
        COUNT(curve.sku)::int AS "curveCount",
        MAX(curve.updated_at) AS "curveUpdatedAt"
      FROM continuous_pricing_inventory inventory
      LEFT JOIN inventory_strategy_pricing_curves curve
        ON curve.seller_key = inventory.seller_key
        AND curve.sku = inventory.sku
      WHERE inventory.seller_key = $1
        AND inventory.in_stock
        AND inventory.quantity > 0`,
      [sellerKey],
      executor,
    );
    return [
      row?.inventoryCount ?? 0,
      row?.inventoryUpdatedAt?.toISOString() ?? "",
      row?.curveCount ?? 0,
      row?.curveUpdatedAt?.toISOString() ?? "",
    ].join(":");
  },

  async findSnapshot(
    sellerKey: string,
    executor?: Queryable,
  ): Promise<InventoryStrategySnapshotItem[]> {
    return query<InventoryStrategySnapshotRow>(
      `${snapshotSelect}
      WHERE inventory.seller_key = $1
        AND inventory.in_stock
        AND inventory.quantity > 0
      ORDER BY inventory.product_line, inventory.sku`,
      [sellerKey],
      executor,
    );
  },

  /** Continuous pricing results since a moment, with the forecasts each recorded. */
  async findForecastGradingRecords(
    sellerKey: string,
    since: Date,
    executor?: Queryable,
  ): Promise<ForecastGradingRecord[]> {
    return query<ForecastGradingRecord>(
      `SELECT
        result.sku,
        result.priced_at AS "pricedAt",
        (result.pricing_details_json->>'quantity')::int AS quantity,
        result.pricing_details_json->'decision'->>'basis' AS basis,
        result.pricing_details_json->'decision'->>'method' AS method,
        (result.pricing_details_json->'decision'->>'estimatedMedianSellDays')::float8
          AS "curveMedianSellDays",
        (result.pricing_details_json->'buyerChoiceForecast'->>'medianSellDays')::float8
          AS "buyerChoiceMedianSellDays",
        result.pricing_details_json->'buyerChoiceForecast'->>'calibration'
          AS "buyerChoiceCalibration",
        (result.pricing_details_json->'conditionRateForecast'->>'medianSellDays')::float8
          AS "conditionRateMedianSellDays",
        result.pricing_details_json->'conditionRateForecast'->>'method'
          AS "conditionRateMethod"
      FROM inventory_batch_results result
      JOIN inventory_batches batch ON batch.batch_number = result.batch_number
      WHERE batch.source_type = 'continuous'
        AND batch.source_label = $1
        AND result.result_status = 'successful'
        AND result.priced_at >= $2
        AND result.pricing_details_json->>'pricingModelVersion' = $3
      ORDER BY result.sku, result.priced_at`,
      [sellerKey, since, PRICING_MODEL_VERSION],
      executor,
    );
  },

  async findInStockSkus(
    sellerKey: string,
    executor?: Queryable,
  ): Promise<number[]> {
    const rows = await query<{ sku: number }>(
      `SELECT sku
      FROM continuous_pricing_inventory
      WHERE seller_key = $1 AND in_stock AND quantity > 0`,
      [sellerKey],
      executor,
    );
    return rows.map((row) => row.sku);
  },

  async findReusableSnapshots(
    sellerKey: string,
    skus: number[],
    minimumIntervalMinutes: number,
    supplyAnalysis: SupplyAnalysisConfig,
    executor?: Queryable,
  ): Promise<InventoryStrategySnapshotItem[]> {
    if (skus.length === 0) return [];
    return query<InventoryStrategySnapshotRow>(
      `${snapshotSelect}
      WHERE inventory.seller_key = $1 AND inventory.sku = ANY($5::int[])
        AND ${reusablePricingCurveWhere}`,
      [
        sellerKey,
        PRICING_MODEL_VERSION,
        minimumIntervalMinutes,
        asJson(supplyAnalysis),
        skus,
      ],
      executor,
    );
  },

  async recordSuccessfulBatch(
    batchNumber: number,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `INSERT INTO inventory_strategy_pricing_curves (
        seller_key,
        sku,
        batch_number,
        pricing_details_json,
        priced_at,
        updated_at
      )
      SELECT
        batch.source_label,
        result.sku,
        result.batch_number,
        result.pricing_details_json,
        result.priced_at,
        NOW()
      FROM inventory_batch_results result
      JOIN inventory_batches batch
        ON batch.batch_number = result.batch_number
      WHERE result.batch_number = $1
        AND batch.source_type IN ('continuous', 'strategy')
        AND result.result_status = 'successful'
        AND result.pricing_details_json IS NOT NULL
        AND CASE
          WHEN jsonb_typeof(result.pricing_details_json->'percentiles') = 'array'
          THEN jsonb_array_length(result.pricing_details_json->'percentiles') > 0
          ELSE FALSE
        END
      ON CONFLICT (seller_key, sku) DO UPDATE SET
        batch_number = EXCLUDED.batch_number,
        pricing_details_json = EXCLUDED.pricing_details_json,
        priced_at = EXCLUDED.priced_at,
        updated_at = NOW()
      WHERE inventory_strategy_pricing_curves.priced_at <= EXCLUDED.priced_at`,
      [batchNumber],
      executor,
    );
  },
};
