import type { Sale } from "~/integrations/tcgplayer/client/get-latest-sales.server";
import {
  createValuesPlaceholders,
  execute,
  query,
  type Queryable,
} from "../database.server";

/** A TCGplayer sale together with the product it belongs to. */
export interface RecordedSale extends Sale {
  productId: number;
}

interface ProductSaleRow {
  productId: number;
  orderDate: Date;
  condition: Sale["condition"];
  variant: Sale["variant"];
  language: Sale["language"];
  quantity: number;
  purchasePrice: number;
  shippingPrice: number;
  listingType: Sale["listingType"];
  customListingId: string;
}

const selectColumns = `
  product_id AS "productId",
  order_date AS "orderDate",
  condition,
  variant,
  language,
  quantity,
  purchase_price::float8 AS "purchasePrice",
  shipping_price::float8 AS "shippingPrice",
  listing_type AS "listingType",
  custom_listing_id AS "customListingId"`;

function toRecordedSale(row: ProductSaleRow): RecordedSale {
  return {
    productId: row.productId,
    orderDate: row.orderDate.toISOString(),
    condition: row.condition,
    variant: row.variant,
    language: row.language,
    quantity: row.quantity,
    purchasePrice: row.purchasePrice,
    shippingPrice: row.shippingPrice,
    listingType: row.listingType,
    customListingId: row.customListingId,
    title: "",
  };
}

const INSERT_COLUMNS = 10;

export const productSalesRepository = {
  /** Keeps each sale once; a sale seen again is ignored. Returns how many were new. */
  async record(
    productId: number,
    sales: Sale[],
    executor?: Queryable,
  ): Promise<number> {
    const rows = sales.filter(
      (sale) => sale.quantity > 0 && Number.isFinite(Date.parse(sale.orderDate)),
    );
    if (rows.length === 0) return 0;
    return execute(
      `INSERT INTO product_sales (
        product_id, order_date, condition, variant, language,
        quantity, purchase_price, shipping_price, listing_type, custom_listing_id
      ) VALUES ${createValuesPlaceholders(rows.length, INSERT_COLUMNS)}
      ON CONFLICT DO NOTHING`,
      rows.flatMap((sale) => [
        productId,
        sale.orderDate,
        sale.condition,
        sale.variant ?? "",
        sale.language ?? "",
        sale.quantity,
        sale.purchasePrice,
        sale.shippingPrice,
        sale.listingType ?? "",
        sale.customListingId ?? "",
      ]),
      executor,
    );
  },

  async findByProducts(
    productIds: number[],
    executor?: Queryable,
  ): Promise<RecordedSale[]> {
    if (productIds.length === 0) return [];
    const rows = await query<ProductSaleRow>(
      `SELECT ${selectColumns}
      FROM product_sales
      WHERE product_id = ANY($1::int[])
      ORDER BY product_id, order_date`,
      [productIds],
      executor,
    );
    return rows.map(toRecordedSale);
  },

  /** Every recorded sale on or after a moment, oldest first. */
  async findSince(since: Date, executor?: Queryable): Promise<RecordedSale[]> {
    const rows = await query<ProductSaleRow>(
      `SELECT ${selectColumns}
      FROM product_sales
      WHERE order_date >= $1
      ORDER BY product_id, order_date`,
      [since],
      executor,
    );
    return rows.map(toRecordedSale);
  },
};
