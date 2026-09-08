import { readJsonResponse } from "~/core/utils/readJsonResponse";
import type {
  ShippingIntakeHistoryRequestOrder,
  ShippingIntakeHistoryResponse,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";

function requestOrder(order: TcgPlayerShippingOrder): ShippingIntakeHistoryRequestOrder {
  return {
    orderNumber: order["Order #"],
    orderDate: order["Order Date"],
    itemCount: order["Item Count"],
    valueOfProducts: order["Value Of Products"],
    products: (order.products ?? []).map((line) => ({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(line.skuId === undefined ? {} : { skuId: line.skuId }),
      ...(line.inventorySkuId === undefined ? {} : { inventorySkuId: line.inventorySkuId }),
    })),
  };
}

export function withoutShippingIntakeHistory(orders: TcgPlayerShippingOrder[]): TcgPlayerShippingOrder[] {
  return orders.map(({ intakeHistory: _history, ...order }) => order);
}

export async function refreshShippingIntakeHistory(
  orders: TcgPlayerShippingOrder[],
  sellerKey: string,
  fetcher: typeof fetch = fetch,
): Promise<TcgPlayerShippingOrder[]> {
  if (!orders.length) return orders;
  const response = await fetcher("/api/shipping-export/intake-history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sellerKey, orders: orders.map(requestOrder) }),
  });
  const payload = await readJsonResponse<ShippingIntakeHistoryResponse>(response, "Failed to refresh intake history.");
  if (payload.histories.some((history) => history.sellerKey !== sellerKey.trim())) {
    throw new Error("Intake history response seller does not match the loaded workflow.");
  }
  const byOrder = new Map(payload.histories.map((history) => [history.orderNumber, history]));
  return orders.map((order) => ({ ...order, intakeHistory: byOrder.get(order["Order #"]) }));
}
