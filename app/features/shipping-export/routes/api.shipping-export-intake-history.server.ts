import { data } from "react-router";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import { enrichShippingOrdersWithIntakeHistory } from "../services/shippingIntakeHistory.server";
import type { ShippingIntakeHistoryRequestOrder, TcgPlayerShippingOrder } from "../types/shippingExport";

const MAX_ORDERS = 500;

function parseOrders(value: unknown): ShippingIntakeHistoryRequestOrder[] {
  if (!Array.isArray(value) || value.length > MAX_ORDERS) throw new Error(`Orders must contain at most ${MAX_ORDERS} items.`);
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each history order must be an object.");
    const order = item as Partial<ShippingIntakeHistoryRequestOrder>;
    if (typeof order.orderNumber !== "string" || !order.orderNumber.trim() || typeof order.orderDate !== "string"
      || !Number.isInteger(order.itemCount) || (order.itemCount ?? -1) < 0 || !Array.isArray(order.products)) throw new Error("History order identity is incomplete.");
    const products = order.products.map((product) => {
      if (!product || typeof product !== "object") throw new Error("History product identity is incomplete.");
      const line = product as ShippingIntakeHistoryRequestOrder["products"][number];
      if (!Number.isInteger(line.quantity) || line.quantity <= 0
        || (line.skuId === undefined && typeof line.inventorySkuId !== "string")) throw new Error("History product identity is incomplete.");
      return line;
    });
    return { orderNumber: order.orderNumber.trim(), orderDate: order.orderDate, itemCount: order.itemCount as number, products };
  });
}

export function createShippingIntakeHistoryAction(dependencies: {
  getConfig?: typeof getShippingExportConfig;
  enrich?: typeof enrichShippingOrdersWithIntakeHistory;
} = {}) {
  const getConfig = dependencies.getConfig ?? getShippingExportConfig;
  const enrich = dependencies.enrich ?? enrichShippingOrdersWithIntakeHistory;
  return async ({ request }: { request: Request }) => {
    if (request.method !== "POST") return data({ error: "Method not allowed" }, { status: 405 });
    try {
      const payload = await request.json() as { sellerKey?: unknown; orders?: unknown };
      const config = await getConfig();
      const sellerKey = config.defaultSellerKey.trim();
      const requestedSeller = typeof payload.sellerKey === "string" ? payload.sellerKey.trim() : "";
      if (!sellerKey) return data({ error: "A configured seller key is required to refresh intake history." }, { status: 400 });
      if (requestedSeller && requestedSeller !== sellerKey) return data({ error: "The intake history seller does not match Shipping Configuration." }, { status: 403 });
      const orders = parseOrders(payload.orders).map<TcgPlayerShippingOrder>((order) => ({
        "Order #": order.orderNumber, "Order Date": order.orderDate, "Value Of Products": 0,
        FirstName: "", LastName: "", Address1: "", Address2: "", City: "", State: "", PostalCode: "",
        Country: "US", "Product Weight": 0, "Shipping Method": "Standard", "Item Count": order.itemCount,
        "Shipping Fee Paid": 0, "Tracking #": "", Carrier: "", products: order.products.map((line) => ({ name: "", unitPrice: 0, ...line })),
      }));
      const enriched = await enrich(orders, sellerKey);
      return data({ histories: enriched.flatMap((order) => order.intakeHistory ? [order.intakeHistory] : []) });
    } catch (error) {
      return data({ error: String(error) }, { status: 400 });
    }
  };
}
