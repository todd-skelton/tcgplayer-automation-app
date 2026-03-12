import type { Product } from "~/features/inventory-management/types/product";
import { asJson, execute, query, queryOne, type Queryable } from "../database.server";

type ProductRow = Product;

export const productsRepository = {
  async findByProductId(
    productId: number,
    productLineId: number,
    executor?: Queryable,
  ): Promise<Product | null> {
    return queryOne<ProductRow>(
      `SELECT
        product_type_name AS "productTypeName",
        rarity_name AS "rarityName",
        sealed,
        product_name AS "productName",
        set_id AS "setId",
        set_code AS "setCode",
        product_id AS "productId",
        set_name AS "setName",
        product_line_id AS "productLineId",
        product_status_id AS "productStatusId",
        product_line_name AS "productLineName",
        skus_json AS "skus"
      FROM products
      WHERE product_id = $1 AND product_line_id = $2`,
      [productId, productLineId],
      executor,
    );
  },

  async findByIds(
    productIds: number[],
    productLineId: number,
    executor?: Queryable,
  ): Promise<Product[]> {
    if (productIds.length === 0) {
      return [];
    }

    return query<ProductRow>(
      `SELECT
        product_type_name AS "productTypeName",
        rarity_name AS "rarityName",
        sealed,
        product_name AS "productName",
        set_id AS "setId",
        set_code AS "setCode",
        product_id AS "productId",
        set_name AS "setName",
        product_line_id AS "productLineId",
        product_status_id AS "productStatusId",
        product_line_name AS "productLineName",
        skus_json AS "skus"
      FROM products
      WHERE product_line_id = $1
        AND product_id = ANY($2::int[])`,
      [productLineId, productIds],
      executor,
    );
  },

  async findBySetId(
    setId: number,
    productLineId?: number,
    executor?: Queryable,
  ): Promise<Product[]> {
    if (productLineId === undefined) {
      return query<ProductRow>(
        `SELECT
          product_type_name AS "productTypeName",
          rarity_name AS "rarityName",
          sealed,
          product_name AS "productName",
          set_id AS "setId",
          set_code AS "setCode",
          product_id AS "productId",
          set_name AS "setName",
          product_line_id AS "productLineId",
          product_status_id AS "productStatusId",
          product_line_name AS "productLineName",
          skus_json AS "skus"
        FROM products
        WHERE set_id = $1`,
        [setId],
        executor,
      );
    }

    return query<ProductRow>(
      `SELECT
        product_type_name AS "productTypeName",
        rarity_name AS "rarityName",
        sealed,
        product_name AS "productName",
        set_id AS "setId",
        set_code AS "setCode",
        product_id AS "productId",
        set_name AS "setName",
        product_line_id AS "productLineId",
        product_status_id AS "productStatusId",
        product_line_name AS "productLineName",
        skus_json AS "skus"
      FROM products
      WHERE set_id = $1
        AND product_line_id = $2`,
      [setId, productLineId],
      executor,
    );
  },

  async upsert(product: Product, executor?: Queryable): Promise<void> {
    await execute(
      `INSERT INTO products (
        product_type_name,
        rarity_name,
        sealed,
        product_name,
        set_id,
        set_code,
        product_id,
        set_name,
        product_line_id,
        product_status_id,
        product_line_name,
        skus_json,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW()
      )
      ON CONFLICT (product_id) DO UPDATE SET
        product_type_name = EXCLUDED.product_type_name,
        rarity_name = EXCLUDED.rarity_name,
        sealed = EXCLUDED.sealed,
        product_name = EXCLUDED.product_name,
        set_id = EXCLUDED.set_id,
        set_code = EXCLUDED.set_code,
        set_name = EXCLUDED.set_name,
        product_line_id = EXCLUDED.product_line_id,
        product_status_id = EXCLUDED.product_status_id,
        product_line_name = EXCLUDED.product_line_name,
        skus_json = EXCLUDED.skus_json,
        updated_at = NOW()`,
      [
        product.productTypeName,
        product.rarityName,
        product.sealed,
        product.productName,
        product.setId,
        product.setCode,
        product.productId,
        product.setName,
        product.productLineId,
        product.productStatusId,
        product.productLineName,
        asJson(product.skus),
      ],
      executor,
    );
  },

  async removeBySetId(
    setId: number,
    productLineId: number,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `DELETE FROM products WHERE set_id = $1 AND product_line_id = $2`,
      [setId, productLineId],
      executor,
    );
  },
};
