/**
 * A signed-out TCGplayer session sees only a product's five most recent
 * sales and is told five is the total, which is exactly what a signed-in
 * session sees for a product with five sales. Pricing on that view is
 * pricing on the wrong history, so it must be told apart before use.
 */
export const ANONYMOUS_SALES_LIMIT = 5;

/** Thrown when TCGplayer answered with the signed-out view of sales history. */
export class SalesHistoryUnavailableError extends Error {}

/**
 * Whether a fetch that asked for more than the signed-out limit came back
 * with exactly that many sales: the whole history of a product with five
 * sales, or the signed-out view of any product.
 */
export function couldBeAnonymousSalesHistory(
  saleCount: number,
  maxSales?: number,
): boolean {
  return (
    saleCount === ANONYMOUS_SALES_LIMIT &&
    (maxSales === undefined || maxSales > ANONYMOUS_SALES_LIMIT)
  );
}
