import type { InventoryStrategySnapshotItem } from "~/features/inventory-strategy/types/inventoryStrategy";
import { execute, query, type Queryable } from "../database.server";

type InventoryStrategySnapshotRow = InventoryStrategySnapshotItem;

export const inventoryStrategyRepository = {
  async findSnapshot(
    sellerKey: string,
    executor?: Queryable,
  ): Promise<InventoryStrategySnapshotItem[]> {
    return query<InventoryStrategySnapshotRow>(
      `SELECT
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
        curve.priced_at AS "strategyPricedAt"
      FROM continuous_pricing_inventory inventory
      LEFT JOIN inventory_strategy_pricing_curves curve
        ON curve.seller_key = inventory.seller_key
        AND curve.sku = inventory.sku
      WHERE inventory.seller_key = $1
        AND inventory.in_stock
        AND inventory.quantity > 0
      ORDER BY inventory.product_line, inventory.sku`,
      [sellerKey],
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
