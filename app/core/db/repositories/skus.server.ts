import type { Sku } from "~/shared/data-types/sku";
import {
  createValuesPlaceholders,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type SkuRow = Sku;

export const skusRepository = {
  async findBySkuAndProductLine(
    sku: number,
    productLineId: number,
    executor?: Queryable,
  ): Promise<Sku | null> {
    return queryOne<SkuRow>(
      `SELECT
        sku,
        condition,
        variant,
        language,
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
        product_line_name AS "productLineName"
      FROM skus
      WHERE sku = $1 AND product_line_id = $2`,
      [sku, productLineId],
      executor,
    );
  },

  async findBySkuIds(
    productLineId: number,
    skuIds: number[],
    executor?: Queryable,
  ): Promise<Sku[]> {
    if (skuIds.length === 0) {
      return [];
    }

    return query<SkuRow>(
      `SELECT
        sku,
        condition,
        variant,
        language,
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
        product_line_name AS "productLineName"
      FROM skus
      WHERE product_line_id = $1
        AND sku = ANY($2::int[])`,
      [productLineId, skuIds],
      executor,
    );
  },

  async insertMany(skus: Sku[], executor?: Queryable): Promise<void> {
    if (skus.length === 0) {
      return;
    }

    const writeBatch = async (client: Queryable) => {
      const chunkSize = 250;

      for (let index = 0; index < skus.length; index += chunkSize) {
        const chunk = skus.slice(index, index + chunkSize);
        const values = chunk.flatMap((sku) => [
          sku.sku,
          sku.condition,
          sku.variant,
          sku.language,
          sku.productTypeName,
          sku.rarityName,
          sku.sealed,
          sku.productName,
          sku.setId,
          sku.setCode,
          sku.productId,
          sku.setName,
          sku.productLineId,
          sku.productStatusId,
          sku.productLineName,
        ]);

        await client.query(
          `INSERT INTO skus (
            sku,
            condition,
            variant,
            language,
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
            product_line_name
          ) VALUES ${createValuesPlaceholders(chunk.length, 15)}
          ON CONFLICT (sku) DO NOTHING`,
          values,
        );
      }
    };

    if (executor) {
      await writeBatch(executor);
      return;
    }

    await withTransaction(async (client) => {
      await writeBatch(client);
    });
  },

  async updateSetInfoByProduct(
    productId: number,
    productLineId: number,
    setInfo: Pick<Sku, "setId" | "setCode" | "setName">,
    executor?: Queryable,
  ): Promise<number> {
    return execute(
      `UPDATE skus
      SET set_id = $1,
          set_code = $2,
          set_name = $3
      WHERE product_id = $4 AND product_line_id = $5`,
      [
        setInfo.setId,
        setInfo.setCode,
        setInfo.setName,
        productId,
        productLineId,
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
      `DELETE FROM skus WHERE set_id = $1 AND product_line_id = $2`,
      [setId, productLineId],
      executor,
    );
  },
};
