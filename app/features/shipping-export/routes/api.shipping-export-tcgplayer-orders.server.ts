import { data } from "react-router";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import {
  loadSellerShippingOrders,
  loadSingleSellerShippingOrder,
} from "../services/tcgplayerSellerOrders.server";
import { sellerOrderHistoryRepository } from "~/core/db";
import { enrichShippingOrdersWithIntakeHistory } from "../services/shippingIntakeHistory.server";

type ShippingTcgplayerOrdersActionDependencies = {
  getShippingExportConfig?: typeof getShippingExportConfig;
  loadSellerShippingOrders?: typeof loadSellerShippingOrders;
  loadSingleSellerShippingOrder?: typeof loadSingleSellerShippingOrder;
  getHistoryCoverage?: typeof sellerOrderHistoryRepository.getCoverage;
  enrichIntakeHistory?: typeof enrichShippingOrdersWithIntakeHistory;
};

export function createShippingTcgplayerOrdersAction(
  dependencies: ShippingTcgplayerOrdersActionDependencies = {},
) {
  const getConfig =
    dependencies.getShippingExportConfig ?? getShippingExportConfig;
  const loadOrders =
    dependencies.loadSellerShippingOrders ?? loadSellerShippingOrders;
  const loadSingleOrder =
    dependencies.loadSingleSellerShippingOrder ?? loadSingleSellerShippingOrder;
  const getHistoryCoverage = dependencies.getHistoryCoverage;
  const enrichIntakeHistory = dependencies.enrichIntakeHistory;

  async function attachHistoryCoverage<T extends { warnings?: string[] }>(
    sellerKey: string,
    response: T,
  ) {
    if (!getHistoryCoverage) return response;
    try {
      return { ...response, historyCoverage: await getHistoryCoverage(sellerKey) };
    } catch (error) {
      return {
        ...response,
        warnings: [
          ...(response.warnings ?? []),
          `Seller order history status is unavailable: ${String(error)}`,
        ],
      };
    }
  }

  async function attachIntakeHistory<T extends { orders: Awaited<ReturnType<typeof loadSellerShippingOrders>>["orders"]; warnings?: string[] }>(
    sellerKey: string,
    response: T,
  ) {
    if (!enrichIntakeHistory) return response;
    try {
      return { ...response, orders: await enrichIntakeHistory(response.orders, sellerKey) };
    } catch (error) {
      return { ...response, warnings: [...(response.warnings ?? []), `Intake history is unavailable: ${String(error)}`] };
    }
  }

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload = (await request.json()) as {
        sellerKey?: unknown;
        orderNumber?: unknown;
      };
      const providedSellerKey =
        typeof payload.sellerKey === "string" ? payload.sellerKey.trim() : "";
      const providedOrderNumber =
        typeof payload.orderNumber === "string" ? payload.orderNumber.trim() : "";
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

      if (providedOrderNumber) {
        const response = await loadSingleOrder(sellerKey, providedOrderNumber);
        const withIntake = await attachIntakeHistory(sellerKey, response);
        return data(await attachHistoryCoverage(sellerKey, withIntake), { status: 200 });
      }

      const response = await loadOrders(sellerKey);
      const withIntake = await attachIntakeHistory(sellerKey, response);
      return data(await attachHistoryCoverage(sellerKey, withIntake), { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
