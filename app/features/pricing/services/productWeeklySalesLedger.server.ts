import { productWeeklySalesRepository } from "~/core/db";
import {
  weeklySalesFromHistory,
  type WeeklySales,
} from "~/core/db/repositories/productWeeklySales.server";
import {
  fetchAnnualPriceHistory,
  type GetPriceHistoryResponse,
} from "~/integrations/tcgplayer/client/get-price-history.server";

export interface ProductWeeklySalesLedgerDependencies {
  fetch: typeof fetchAnnualPriceHistory;
  record: (weeks: WeeklySales[]) => Promise<unknown>;
}

const defaultDependencies: ProductWeeklySalesLedgerDependencies = {
  fetch: fetchAnnualPriceHistory,
  record: (weeks) => productWeeklySalesRepository.record(weeks),
};

/**
 * Fetches a product's annual price history and keeps its traded weeks in
 * the weekly sales ledger. Pricing already fetches the history once per
 * product, so the ledger costs no extra requests; recording is best effort
 * and never delays or fails the price.
 */
export async function fetchAnnualPriceHistoryAndRecord(
  productId: number,
  dependencies: Partial<ProductWeeklySalesLedgerDependencies> = {},
): Promise<GetPriceHistoryResponse | undefined> {
  const { fetch, record } = { ...defaultDependencies, ...dependencies };
  const history = await fetch(productId);
  if (history) {
    void Promise.resolve()
      .then(() => record(weeklySalesFromHistory(productId, history)))
      .catch((error: unknown) => {
        console.warn(
          `Recording weekly sales for product ${productId} failed`,
          error,
        );
      });
  }
  return history;
}
