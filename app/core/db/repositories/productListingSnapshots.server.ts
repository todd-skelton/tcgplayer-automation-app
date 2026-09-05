import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import {
  MAX_ROWS_PER_INSERT,
  chunk,
  createValuesPlaceholders,
  execute,
  query,
  type Queryable,
} from "../database.server";

/** The competing asks for one condition of a product on one day. */
export interface ListingSnapshot {
  productId: number;
  variant: string;
  language: string;
  condition: Condition;
  /** ISO date the listings were seen. */
  observedOn: string;
  sellerCount: number;
  cheapestDeliveredPrice: number | null;
  secondCheapestDeliveredPrice: number | null;
}

interface ListingSnapshotRow extends Omit<ListingSnapshot, "observedOn"> {
  observedOn: Date;
}

const selectColumns = `
  product_id AS "productId",
  variant,
  language,
  condition,
  observed_on AS "observedOn",
  seller_count AS "sellerCount",
  cheapest_delivered_price::float8 AS "cheapestDeliveredPrice",
  second_cheapest_delivered_price::float8 AS "secondCheapestDeliveredPrice"`;

const toSnapshot = (row: ListingSnapshotRow): ListingSnapshot => ({
  ...row,
  observedOn: row.observedOn.toISOString().slice(0, 10),
});

const INSERT_COLUMNS = 8;

/** Writes one chunk of snapshots; a later look the same day replaces the earlier one. */
function recordChunk(rows: ListingSnapshot[], executor?: Queryable): Promise<number> {
  return execute(
    `INSERT INTO product_listing_snapshots (
      product_id, variant, language, condition, observed_on,
      seller_count, cheapest_delivered_price, second_cheapest_delivered_price
    ) VALUES ${createValuesPlaceholders(rows.length, INSERT_COLUMNS)}
    ON CONFLICT (product_id, variant, language, condition, observed_on) DO UPDATE SET
      seller_count = EXCLUDED.seller_count,
      cheapest_delivered_price = EXCLUDED.cheapest_delivered_price,
      second_cheapest_delivered_price = EXCLUDED.second_cheapest_delivered_price,
      observed_at = NOW()`,
    rows.flatMap((snapshot) => [
      snapshot.productId,
      snapshot.variant,
      snapshot.language,
      snapshot.condition,
      snapshot.observedOn,
      snapshot.sellerCount,
      snapshot.cheapestDeliveredPrice,
      snapshot.secondCheapestDeliveredPrice,
    ]),
    executor,
  );
}

export const productListingSnapshotsRepository = {
  /** Keeps one snapshot per condition per day. Returns how many were written. */
  async record(
    snapshots: ListingSnapshot[],
    executor?: Queryable,
  ): Promise<number> {
    let written = 0;
    for (const rows of chunk(snapshots, MAX_ROWS_PER_INSERT)) {
      written += await recordChunk(rows, executor);
    }
    return written;
  },

  async findByProducts(
    productIds: number[],
    executor?: Queryable,
  ): Promise<ListingSnapshot[]> {
    if (productIds.length === 0) return [];
    const rows = await query<ListingSnapshotRow>(
      `SELECT ${selectColumns}
      FROM product_listing_snapshots
      WHERE product_id = ANY($1::int[])
      ORDER BY product_id, observed_on`,
      [productIds],
      executor,
    );
    return rows.map(toSnapshot);
  },

  /** Every snapshot taken on or after a date, oldest first. */
  async findSince(
    since: Date,
    executor?: Queryable,
  ): Promise<ListingSnapshot[]> {
    const rows = await query<ListingSnapshotRow>(
      `SELECT ${selectColumns}
      FROM product_listing_snapshots
      WHERE observed_on >= $1
      ORDER BY product_id, observed_on`,
      [since],
      executor,
    );
    return rows.map(toSnapshot);
  },
};
