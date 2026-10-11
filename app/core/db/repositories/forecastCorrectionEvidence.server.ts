import type { ListedPrice, SkuSale } from "~/features/forecast-correction/domain/forecastCorrectionModel";
import { query, queryOne, type Queryable } from "../database.server";

/** Listings counted before this much ahead of the window still need the sales since their count. */
const COUNT_LEAD_MS = 86_400_000;

export const forecastCorrectionEvidenceRepository = {
  /** The span the latest complete, gapless order history sync covers. */
  async findOrderHistoryCoverage(
    sellerKey: string,
    executor?: Queryable,
  ): Promise<{ coveredFrom: Date; coveredThrough: Date } | null> {
    return queryOne<{ coveredFrom: Date; coveredThrough: Date }>(
      `SELECT observed_from AS "coveredFrom",observed_through AS "coveredThrough"
       FROM seller_order_sync_runs
       WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND gaps='[]'::jsonb
         AND observed_from IS NOT NULL AND observed_through IS NOT NULL
       ORDER BY observed_through DESC,id DESC LIMIT 1`,
      [sellerKey], executor,
    );
  },

  /**
   * Prices published in the window with a modeled sell-time forecast from the
   * given pricing model, the stock counted for them, and when the SKU's next
   * price replaced them. Medians are read back before any correction.
   */
  async findListedPrices(
    sellerKey: string,
    from: Date,
    through: Date,
    pricingModelVersion: string,
    executor?: Queryable,
  ): Promise<ListedPrice[]> {
    return query<ListedPrice>(
      `WITH published AS (
        SELECT item.sku,catalog.product_line_id AS "productLineId",item.product_line AS "productLine",
          item.published_at AS "listedAt",
          LEAD(item.published_at) OVER (PARTITION BY item.sku ORDER BY item.published_at,item.id) AS "replacedAt",
          batch_item.total_quantity+GREATEST(batch_item.add_to_quantity,0) AS quantity,
          batch_item.created_at AS "countedAt",
          item.forecast_evidence->>'pricingModelVersion' AS "pricingModelVersion",
          item.forecast_evidence->'decision'->>'basis' AS basis,
          CASE WHEN jsonb_typeof(item.forecast_evidence->'decision'->'estimatedMedianSellDays')='number'
            THEN (item.forecast_evidence->'decision'->>'estimatedMedianSellDays')::float8 END AS "medianSellDays",
          CASE WHEN jsonb_typeof(item.forecast_evidence->'decision'->'forecastCorrectionMultiplier')='number'
            THEN (item.forecast_evidence->'decision'->>'forecastCorrectionMultiplier')::float8 END AS "correctionMultiplier"
        FROM inventory_publication_items item
        JOIN inventory_publications publication ON publication.id=item.publication_id
        LEFT JOIN inventory_batch_items batch_item
          ON batch_item.batch_number=item.batch_number AND batch_item.sku=item.sku
        LEFT JOIN skus catalog ON catalog.sku=item.sku
        WHERE publication.seller_key=$1 AND item.status='published'
          AND item.published_at>=$2 AND item.published_at<$3
      )
      SELECT sku,"productLineId","productLine","listedAt","replacedAt",quantity,"countedAt",
        "medianSellDays"/CASE WHEN "correctionMultiplier">0 THEN "correctionMultiplier" ELSE 1 END
          AS "forecastMedianSellDays"
      FROM published
      WHERE quantity>0 AND "countedAt" IS NOT NULL AND basis='modeled'
        AND "pricingModelVersion"=$4 AND "medianSellDays">0
      ORDER BY "listedAt",sku`,
      [sellerKey, from, through, pricingModelVersion], executor,
    );
  },

  /** Copies of each SKU sold per order in the window, and the day before it, that were not canceled. */
  async findSkuSales(sellerKey: string, from: Date, through: Date, executor?: Queryable): Promise<SkuSale[]> {
    return query<SkuSale>(
      `SELECT line.sku_id::int AS sku,orders.order_time AS "soldAt",SUM(line.ordered_quantity)::int AS quantity
      FROM seller_orders orders
      JOIN seller_order_lines line ON line.order_id=orders.id
      WHERE orders.seller_key=$1 AND orders.order_time>=$2 AND orders.order_time<$3
        AND orders.lifecycle<>'canceled' AND line.ordered_quantity>0
        AND line.sku_id~'^[1-9][0-9]{0,8}$'
      GROUP BY orders.id,line.sku_id,orders.order_time
      ORDER BY orders.order_time,orders.id`,
      [sellerKey, new Date(from.getTime() - COUNT_LEAD_MS), through], executor,
    );
  },
};
