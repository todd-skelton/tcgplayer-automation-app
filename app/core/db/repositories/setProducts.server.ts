import type { SetProduct } from "~/shared/data-types/setProduct";
import {
  createValuesPlaceholders,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type SetProductRow = SetProduct;

export const setProductsRepository = {
  async findBySetNameId(
    setNameId: number,
    executor?: Queryable,
  ): Promise<SetProduct[]> {
    return query<SetProductRow>(
      `SELECT
        set_name_id AS "setNameId",
        product_id AS "productId",
        game,
        number,
        product_name AS "productName",
        rarity,
        set_name AS "set",
        set_abbrv AS "setAbbrv",
        type,
        display_name AS "displayName"
      FROM set_products
      WHERE set_name_id = $1
      ORDER BY product_name ASC`,
      [setNameId],
      executor,
    );
  },

  async findByProductId(
    productId: number,
    executor?: Queryable,
  ): Promise<SetProduct | null> {
    return queryOne<SetProductRow>(
      `SELECT
        set_name_id AS "setNameId",
        product_id AS "productId",
        game,
        number,
        product_name AS "productName",
        rarity,
        set_name AS "set",
        set_abbrv AS "setAbbrv",
        type,
        display_name AS "displayName"
      FROM set_products
      WHERE product_id = $1`,
      [productId],
      executor,
    );
  },

  async findByProductIds(
    productIds: number[],
    executor?: Queryable,
  ): Promise<SetProduct[]> {
    if (productIds.length === 0) {
      return [];
    }

    return query<SetProductRow>(
      `SELECT
        set_name_id AS "setNameId",
        product_id AS "productId",
        game,
        number,
        product_name AS "productName",
        rarity,
        set_name AS "set",
        set_abbrv AS "setAbbrv",
        type,
        display_name AS "displayName"
      FROM set_products
      WHERE product_id = ANY($1::int[])`,
      [productIds],
      executor,
    );
  },

  async upsert(setProduct: SetProduct, executor?: Queryable): Promise<number> {
    return execute(
      `INSERT INTO set_products (
        set_name_id,
        product_id,
        game,
        number,
        product_name,
        rarity,
        set_name,
        set_abbrv,
        type,
        display_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (product_id) DO UPDATE SET
        set_name_id = EXCLUDED.set_name_id,
        game = EXCLUDED.game,
        number = EXCLUDED.number,
        product_name = EXCLUDED.product_name,
        rarity = EXCLUDED.rarity,
        set_name = EXCLUDED.set_name,
        set_abbrv = EXCLUDED.set_abbrv,
        type = EXCLUDED.type,
        display_name = EXCLUDED.display_name`,
      [
        setProduct.setNameId,
        setProduct.productId,
        setProduct.game,
        setProduct.number,
        setProduct.productName,
        setProduct.rarity,
        setProduct.set,
        setProduct.setAbbrv,
        setProduct.type,
        setProduct.displayName ?? null,
      ],
      executor,
    );
  },

  async upsertMany(setProducts: SetProduct[]): Promise<void> {
    if (setProducts.length === 0) {
      return;
    }

    await withTransaction(async (client) => {
      const chunkSize = 250;

      for (let index = 0; index < setProducts.length; index += chunkSize) {
        const chunk = setProducts.slice(index, index + chunkSize);
        const values = chunk.flatMap((setProduct) => [
          setProduct.setNameId,
          setProduct.productId,
          setProduct.game,
          setProduct.number,
          setProduct.productName,
          setProduct.rarity,
          setProduct.set,
          setProduct.setAbbrv,
          setProduct.type,
          setProduct.displayName ?? null,
        ]);

        await client.query(
          `INSERT INTO set_products (
            set_name_id,
            product_id,
            game,
            number,
            product_name,
            rarity,
            set_name,
            set_abbrv,
            type,
            display_name
          ) VALUES ${createValuesPlaceholders(chunk.length, 10)}
          ON CONFLICT (product_id) DO UPDATE SET
            set_name_id = EXCLUDED.set_name_id,
            game = EXCLUDED.game,
            number = EXCLUDED.number,
            product_name = EXCLUDED.product_name,
            rarity = EXCLUDED.rarity,
            set_name = EXCLUDED.set_name,
            set_abbrv = EXCLUDED.set_abbrv,
            type = EXCLUDED.type,
            display_name = EXCLUDED.display_name`,
          values,
        );
      }
    });
  },

  async removeBySetNameId(
    setNameId: number,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `DELETE FROM set_products WHERE set_name_id = $1`,
      [setNameId],
      executor,
    );
  },
};
