import { execute, query, type Queryable } from "../database.server";

/**
 * Remembers TCGplayer's product count for a set at the moment every listed
 * product was confirmed stored, so later syncs can skip unchanged sets.
 */
export const categorySetSyncsRepository = {
  async findVerifiedProductCounts(
    categoryId: number,
    executor?: Queryable,
  ): Promise<Map<number, number>> {
    const rows = await query<{ setNameId: number; verifiedProductCount: number }>(
      `SELECT
        syncs.set_name_id AS "setNameId",
        syncs.verified_product_count AS "verifiedProductCount"
      FROM category_set_syncs syncs
      INNER JOIN category_sets sets
        ON sets.set_name_id = syncs.set_name_id
      WHERE sets.category_id = $1`,
      [categoryId],
      executor,
    );

    return new Map(rows.map((row) => [row.setNameId, row.verifiedProductCount]));
  },

  async recordVerifiedProductCount(
    setNameId: number,
    verifiedProductCount: number,
    executor?: Queryable,
  ): Promise<void> {
    await execute(
      `INSERT INTO category_set_syncs (set_name_id, verified_product_count, verified_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (set_name_id) DO UPDATE SET
        verified_product_count = EXCLUDED.verified_product_count,
        verified_at = EXCLUDED.verified_at`,
      [setNameId, verifiedProductCount],
      executor,
    );
  },
};
