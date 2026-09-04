import { fetchMarketPricesBySku } from "~/integrations/tcgplayer/client/get-price-points.server";
import type { TcgPlayerShippingOrder } from "../types/shippingExport";

export type FetchMarketPricesFn = (skus: number[]) => Promise<Map<number, number>>;

export interface AttachMarketPricesResult {
  orders: TcgPlayerShippingOrder[];
  warning?: string;
}

function collectLineSkus(orders: TcgPlayerShippingOrder[]): number[] {
  return orders.flatMap((order) =>
    (order.products ?? []).flatMap((line) =>
      line.skuId !== undefined ? [line.skuId] : [],
    ),
  );
}

/**
 * Attaches the current market price to every order line whose SKU has one.
 * A failed lookup leaves the lines untouched and reports a warning, so the
 * shipping workflow keeps working without market comparisons.
 */
export async function attachMarketPricesToOrders(
  orders: TcgPlayerShippingOrder[],
  fetchMarketPrices: FetchMarketPricesFn = fetchMarketPricesBySku,
): Promise<AttachMarketPricesResult> {
  const skus = collectLineSkus(orders);

  if (skus.length === 0) {
    return { orders };
  }

  let marketPrices: Map<number, number>;

  try {
    marketPrices = await fetchMarketPrices(skus);
  } catch (error) {
    return {
      orders,
      warning: `Market prices could not be loaded, so market comparisons are unavailable: ${String(error)}`,
    };
  }

  return {
    orders: orders.map((order) => {
      if (!order.products) {
        return order;
      }

      return {
        ...order,
        products: order.products.map((line) => {
          const marketPrice =
            line.skuId !== undefined ? marketPrices.get(line.skuId) : undefined;

          return marketPrice !== undefined ? { ...line, marketPrice } : line;
        }),
      };
    }),
  };
}
