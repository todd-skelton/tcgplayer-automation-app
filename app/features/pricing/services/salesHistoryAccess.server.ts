import { productSalesRepository } from "~/core/db";
import { getLatestSales } from "~/integrations/tcgplayer/client/get-latest-sales.server";
import {
  ANONYMOUS_SALES_LIMIT,
  SalesHistoryUnavailableError,
} from "./salesHistoryAccess";

export { SalesHistoryUnavailableError } from "./salesHistoryAccess";

const BUSIEST_PRODUCT_LOOKBACK_DAYS = 7;

export interface SalesHistoryAccessDependencies {
  /** A product that the sales ledger has seen sell often recently. */
  findBusiestProduct: () => Promise<number | undefined>;
  /** How many sales TCGplayer reports for a product. */
  fetchReportedSalesTotal: (productId: number) => Promise<number>;
}

const defaultDependencies: SalesHistoryAccessDependencies = {
  findBusiestProduct: () =>
    productSalesRepository.findBusiestProduct(
      new Date(Date.now() - BUSIEST_PRODUCT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    ),
  fetchReportedSalesTotal: async (productId) => {
    const response = await getLatestSales(
      { id: productId },
      {
        conditions: [],
        languages: [],
        variants: [],
        listingType: "ListingWithoutPhotos",
        offset: 0,
        limit: ANONYMOUS_SALES_LIMIT + 1,
      },
    );
    return response.totalResults;
  },
};

/**
 * Confirms the session still sees full sales history by asking for a
 * product the ledger knows sold more than five times this week. A
 * signed-out session reports five for it too. With an empty ledger there
 * is nothing to ask about, so the answer is trusted.
 */
export async function assertSalesHistoryAccess(
  dependencies: Partial<SalesHistoryAccessDependencies> = {},
): Promise<void> {
  const { findBusiestProduct, fetchReportedSalesTotal } = {
    ...defaultDependencies,
    ...dependencies,
  };
  const productId = await findBusiestProduct();
  if (productId === undefined) return;
  const total = await fetchReportedSalesTotal(productId);
  if (total > ANONYMOUS_SALES_LIMIT) return;
  throw new SalesHistoryUnavailableError(
    `TCGplayer answered with the signed-out view of sales history: product ${productId} sold more than ${ANONYMOUS_SALES_LIMIT} times this week yet only ${total} sales were reported. Renew the TCGplayer auth cookie in HTTP configuration before pricing.`,
  );
}
