import type { ProductLine } from "~/shared/data-types/productLine";
import {
  createValuesPlaceholders,
  execute,
  query,
  queryOne,
  withTransaction,
  type Queryable,
} from "../database.server";

type ProductLineRow = {
  productLineId: number;
  productLineName: string;
  productLineUrlName: string;
  isDirect: boolean;
};

function mapRow(row: ProductLineRow): ProductLine {
  return row;
}

export const productLinesRepository = {
  async findAll(executor?: Queryable): Promise<ProductLine[]> {
    const rows = await query<ProductLineRow>(
      `SELECT
        product_line_id AS "productLineId",
        product_line_name AS "productLineName",
        product_line_url_name AS "productLineUrlName",
        is_direct AS "isDirect"
      FROM product_lines
      ORDER BY product_line_name ASC`,
      [],
      executor,
    );

    return rows.map(mapRow);
  },

  async findById(
    productLineId: number,
    executor?: Queryable,
  ): Promise<ProductLine | null> {
    const row = await queryOne<ProductLineRow>(
      `SELECT
        product_line_id AS "productLineId",
        product_line_name AS "productLineName",
        product_line_url_name AS "productLineUrlName",
        is_direct AS "isDirect"
      FROM product_lines
      WHERE product_line_id = $1`,
      [productLineId],
      executor,
    );

    return row ? mapRow(row) : null;
  },

  async findByUrlName(
    productLineUrlName: string,
    executor?: Queryable,
  ): Promise<ProductLine | null> {
    const row = await queryOne<ProductLineRow>(
      `SELECT
        product_line_id AS "productLineId",
        product_line_name AS "productLineName",
        product_line_url_name AS "productLineUrlName",
        is_direct AS "isDirect"
      FROM product_lines
      WHERE product_line_url_name = $1`,
      [productLineUrlName],
      executor,
    );

    return row ? mapRow(row) : null;
  },

  async findByNameOrUrlName(
    productLineName: string,
    productLineUrlName: string,
    executor?: Queryable,
  ): Promise<ProductLine | null> {
    const row = await queryOne<ProductLineRow>(
      `SELECT
        product_line_id AS "productLineId",
        product_line_name AS "productLineName",
        product_line_url_name AS "productLineUrlName",
        is_direct AS "isDirect"
      FROM product_lines
      WHERE product_line_name = $1
         OR product_line_url_name = $2
      LIMIT 1`,
      [productLineName, productLineUrlName],
      executor,
    );

    return row ? mapRow(row) : null;
  },

  async upsert(productLine: ProductLine, executor?: Queryable): Promise<void> {
    await execute(
      `INSERT INTO product_lines (
        product_line_id,
        product_line_name,
        product_line_url_name,
        is_direct
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (product_line_id) DO UPDATE SET
        product_line_name = EXCLUDED.product_line_name,
        product_line_url_name = EXCLUDED.product_line_url_name,
        is_direct = EXCLUDED.is_direct`,
      [
        productLine.productLineId,
        productLine.productLineName,
        productLine.productLineUrlName,
        productLine.isDirect,
      ],
      executor,
    );
  },

  async upsertMany(productLines: ProductLine[]): Promise<void> {
    if (productLines.length === 0) {
      return;
    }

    await withTransaction(async (client) => {
      const chunkSize = 250;

      for (let index = 0; index < productLines.length; index += chunkSize) {
        const chunk = productLines.slice(index, index + chunkSize);
        const values = chunk.flatMap((productLine) => [
          productLine.productLineId,
          productLine.productLineName,
          productLine.productLineUrlName,
          productLine.isDirect,
        ]);

        await client.query(
          `INSERT INTO product_lines (
            product_line_id,
            product_line_name,
            product_line_url_name,
            is_direct
          ) VALUES ${createValuesPlaceholders(chunk.length, 4)}
          ON CONFLICT (product_line_id) DO UPDATE SET
            product_line_name = EXCLUDED.product_line_name,
            product_line_url_name = EXCLUDED.product_line_url_name,
            is_direct = EXCLUDED.is_direct`,
          values,
        );
      }
    });
  },
};
