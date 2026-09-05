import type { GetPriceHistoryResponse } from "~/integrations/tcgplayer/client/get-price-history.server";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import {
  MAX_ROWS_PER_INSERT,
  chunk,
  createValuesPlaceholders,
  execute,
  query,
  type Queryable,
} from "../database.server";

/** Every sale of one SKU in one week, as the annual price history reports it. */
export interface WeeklySales {
  productId: number;
  skuId: number;
  condition: Condition;
  variant: string;
  language: string;
  /** ISO date of the week's first day. */
  weekStart: string;
  transactions: number;
  quantity: number;
  lowSalePrice: number | null;
  highSalePrice: number | null;
  lowSalePriceWithShipping: number | null;
  highSalePriceWithShipping: number | null;
  tcgMarketPrice: number | null;
}

interface WeeklySalesRow extends Omit<WeeklySales, "weekStart"> {
  weekStart: Date;
}

const selectColumns = `
  product_id AS "productId",
  sku_id AS "skuId",
  condition,
  variant,
  language,
  week_start AS "weekStart",
  transactions,
  quantity,
  low_sale_price::float8 AS "lowSalePrice",
  high_sale_price::float8 AS "highSalePrice",
  low_sale_price_with_shipping::float8 AS "lowSalePriceWithShipping",
  high_sale_price_with_shipping::float8 AS "highSalePriceWithShipping",
  tcg_market_price::float8 AS "tcgMarketPrice"`;

const toWeeklySales = (row: WeeklySalesRow): WeeklySales => ({
  ...row,
  weekStart: row.weekStart.toISOString().slice(0, 10),
});

const price = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** The traded weeks in a price history response, ready to record. */
export function weeklySalesFromHistory(
  productId: number,
  history: GetPriceHistoryResponse,
): WeeklySales[] {
  return history.result.flatMap((entry) => {
    const skuId = Number(entry.skuId);
    if (!(skuId > 0)) return [];
    return entry.buckets.flatMap((bucket): WeeklySales[] => {
      const transactions = Number(bucket.transactionCount);
      const weekStart = Date.parse(bucket.bucketStartDate);
      if (!(transactions > 0) || !Number.isFinite(weekStart)) return [];
      return [
        {
          productId,
          skuId,
          condition: entry.condition as Condition,
          variant: entry.variant ?? "",
          language: entry.language ?? "",
          weekStart: new Date(weekStart).toISOString().slice(0, 10),
          transactions,
          quantity: Math.max(0, Number(bucket.quantitySold) || 0),
          lowSalePrice: price(bucket.lowSalePrice),
          highSalePrice: price(bucket.highSalePrice),
          lowSalePriceWithShipping: price(bucket.lowSalePriceWithShipping),
          highSalePriceWithShipping: price(bucket.highSalePriceWithShipping),
          tcgMarketPrice: price(bucket.marketPrice),
        },
      ];
    });
  });
}

const INSERT_COLUMNS = 13;

/** Writes one chunk of weeks; a week already stored is rewritten only when its figures changed. */
function recordChunk(rows: WeeklySales[], executor?: Queryable): Promise<number> {
  return execute(
    `INSERT INTO product_weekly_sales (
      sku_id, product_id, condition, variant, language, week_start,
      transactions, quantity, low_sale_price, high_sale_price,
      low_sale_price_with_shipping, high_sale_price_with_shipping, tcg_market_price
    ) VALUES ${createValuesPlaceholders(rows.length, INSERT_COLUMNS)}
    ON CONFLICT (sku_id, week_start) DO UPDATE SET
      transactions = EXCLUDED.transactions,
      quantity = EXCLUDED.quantity,
      low_sale_price = EXCLUDED.low_sale_price,
      high_sale_price = EXCLUDED.high_sale_price,
      low_sale_price_with_shipping = EXCLUDED.low_sale_price_with_shipping,
      high_sale_price_with_shipping = EXCLUDED.high_sale_price_with_shipping,
      tcg_market_price = EXCLUDED.tcg_market_price,
      updated_at = NOW()
    WHERE product_weekly_sales.transactions IS DISTINCT FROM EXCLUDED.transactions
      OR product_weekly_sales.quantity IS DISTINCT FROM EXCLUDED.quantity
      OR product_weekly_sales.low_sale_price IS DISTINCT FROM EXCLUDED.low_sale_price
      OR product_weekly_sales.high_sale_price IS DISTINCT FROM EXCLUDED.high_sale_price
      OR product_weekly_sales.low_sale_price_with_shipping IS DISTINCT FROM EXCLUDED.low_sale_price_with_shipping
      OR product_weekly_sales.high_sale_price_with_shipping IS DISTINCT FROM EXCLUDED.high_sale_price_with_shipping
      OR product_weekly_sales.tcg_market_price IS DISTINCT FROM EXCLUDED.tcg_market_price`,
    rows.flatMap((week) => [
      week.skuId,
      week.productId,
      week.condition,
      week.variant,
      week.language,
      week.weekStart,
      week.transactions,
      week.quantity,
      week.lowSalePrice,
      week.highSalePrice,
      week.lowSalePriceWithShipping,
      week.highSalePriceWithShipping,
      week.tcgMarketPrice,
    ]),
    executor,
  );
}

export const productWeeklySalesRepository = {
  /** Writes each traded week once and rewrites weeks whose figures changed. Returns how many were written. */
  async record(weeks: WeeklySales[], executor?: Queryable): Promise<number> {
    let written = 0;
    for (const rows of chunk(weeks, MAX_ROWS_PER_INSERT)) {
      written += await recordChunk(rows, executor);
    }
    return written;
  },

  async findByProducts(
    productIds: number[],
    executor?: Queryable,
  ): Promise<WeeklySales[]> {
    if (productIds.length === 0) return [];
    const rows = await query<WeeklySalesRow>(
      `SELECT ${selectColumns}
      FROM product_weekly_sales
      WHERE product_id = ANY($1::int[])
      ORDER BY product_id, sku_id, week_start`,
      [productIds],
      executor,
    );
    return rows.map(toWeeklySales);
  },

  /** Every recorded week starting on or after a date, oldest first. */
  async findSince(since: Date, executor?: Queryable): Promise<WeeklySales[]> {
    const rows = await query<WeeklySalesRow>(
      `SELECT ${selectColumns}
      FROM product_weekly_sales
      WHERE week_start >= $1
      ORDER BY product_id, sku_id, week_start`,
      [since],
      executor,
    );
    return rows.map(toWeeklySales);
  },
};
