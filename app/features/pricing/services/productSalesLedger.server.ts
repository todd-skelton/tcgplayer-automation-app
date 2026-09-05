import { productSalesRepository } from "~/core/db";
import {
  getAllLatestSales,
  type GetLastSalesRequestParams,
  type GetLastestSalesRequestBody,
  type Sale,
} from "~/integrations/tcgplayer/client/get-latest-sales.server";

export interface ProductSalesLedgerDependencies {
  fetch: typeof getAllLatestSales;
  record: (productId: number, sales: Sale[]) => Promise<unknown>;
}

const defaultDependencies: ProductSalesLedgerDependencies = {
  fetch: getAllLatestSales,
  record: (productId, sales) => productSalesRepository.record(productId, sales),
};

/**
 * Fetches the latest sales and keeps a copy in the product sales ledger.
 * Every pricing run already pays for these rows, so the ledger costs no
 * extra requests. Recording is best effort: it never delays or fails the
 * price.
 */
export async function fetchLatestSalesAndRecord(
  params: GetLastSalesRequestParams,
  body: GetLastestSalesRequestBody,
  maxSales?: number,
  dependencies: Partial<ProductSalesLedgerDependencies> = {},
): Promise<Sale[]> {
  const { fetch, record } = { ...defaultDependencies, ...dependencies };
  const sales = await fetch(params, body, maxSales);
  if (sales.length > 0) {
    void Promise.resolve()
      .then(() => record(params.id, sales))
      .catch((error: unknown) => {
        console.warn(
          `Recording ${sales.length} sales for product ${params.id} failed`,
          error,
        );
      });
  }
  return sales;
}
