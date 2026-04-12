import { data } from "react-router";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import { loadSellerShippingOrders } from "../services/tcgplayerSellerOrders.server";

type ShippingTcgplayerOrdersActionDependencies = {
  getShippingExportConfig?: typeof getShippingExportConfig;
  loadSellerShippingOrders?: typeof loadSellerShippingOrders;
};

export function createShippingTcgplayerOrdersAction(
  dependencies: ShippingTcgplayerOrdersActionDependencies = {},
) {
  const getConfig =
    dependencies.getShippingExportConfig ?? getShippingExportConfig;
  const loadOrders =
    dependencies.loadSellerShippingOrders ?? loadSellerShippingOrders;

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload = (await request.json()) as { sellerKey?: unknown };
      const providedSellerKey =
        typeof payload.sellerKey === "string" ? payload.sellerKey.trim() : "";
      const config = await getConfig();
      const sellerKey = providedSellerKey || config.defaultSellerKey.trim();

      if (!sellerKey) {
        return data(
          {
            error:
              "A seller key is required. Enter one on the shipping page or save a default in Shipping Configuration.",
          },
          { status: 400 },
        );
      }

      const response = await loadOrders(sellerKey);
      return data(response, { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
