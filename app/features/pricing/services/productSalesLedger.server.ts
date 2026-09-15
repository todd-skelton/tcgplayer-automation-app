import { productSalesRepository } from "~/core/db";
import {
  getAllLatestSales,
  type GetLastSalesRequestParams,
  type GetLastestSalesRequestBody,
  type Sale,
} from "~/integrations/tcgplayer/client/get-latest-sales.server";
import { couldBeAnonymousSalesHistory } from "./salesHistoryAccess";
import { assertSalesHistoryAccess } from "./salesHistoryAccess.server";

export interface ProductSalesLedgerDependencies {
  fetch: typeof getAllLatestSales;
  record: (productId: number, sales: Sale[]) => Promise<unknown>;
  /** Rejects when the session no longer sees full sales history. */
  assertFullHistory: () => Promise<void>;
}

const defaultDependencies: ProductSalesLedgerDependencies = {
  fetch: getAllLatestSales,
  record: (productId, sales) => productSalesRepository.record(productId, sales),
  assertFullHistory: () => assertSalesHistoryAccess(),
};

/**
 * Fetches the latest sales and keeps a copy in the product sales ledger.
 * Every pricing run already pays for these rows, so the ledger costs no
 * extra requests. Recording is best effort: it never delays or fails the
 * price. A response that could be the signed-out view is checked before
 * it is trusted, because pricing on five sales is not pricing.
 */
export async function fetchLatestSalesAndRecord(
  params: GetLastSalesRequestParams,
  body: GetLastestSalesRequestBody,
  maxSales?: number,
  dependencies: Partial<ProductSalesLedgerDependencies> = {},
): Promise<Sale[]> {
  const { fetch, record, assertFullHistory } = {
    ...defaultDependencies,
    ...dependencies,
  };
  const sales = await fetch(params, body, maxSales);
  if (couldBeAnonymousSalesHistory(sales.length, maxSales)) {
    await assertFullHistory();
  }
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
