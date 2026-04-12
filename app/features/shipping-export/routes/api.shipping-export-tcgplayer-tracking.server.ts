import { data } from "react-router";
import { applyTrackingToSellerOrders } from "../services/tcgplayerTracking.server";
import type {
  ShippingTrackingApplyRequest,
  ShippingTrackingApplyRequestItem,
} from "../types/shippingExport";

type ShippingTcgplayerTrackingActionDependencies = {
  applyTrackingToSellerOrders?: typeof applyTrackingToSellerOrders;
};

function isValidTrackingUpdate(
  value: unknown,
): value is ShippingTrackingApplyRequestItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const update = value as Record<string, unknown>;

  return (
    typeof update.orderNumber === "string" &&
    update.orderNumber.trim().length > 0 &&
    typeof update.carrier === "string" &&
    update.carrier.trim().length > 0 &&
    typeof update.trackingNumber === "string" &&
    update.trackingNumber.trim().length > 0
  );
}

export function createShippingTcgplayerTrackingAction(
  dependencies: ShippingTcgplayerTrackingActionDependencies = {},
) {
  const applyTracking =
    dependencies.applyTrackingToSellerOrders ?? applyTrackingToSellerOrders;

  return async function action({ request }: { request: Request }) {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    try {
      const payload =
        (await request.json()) as Partial<ShippingTrackingApplyRequest>;

      if (!Array.isArray(payload.updates) || payload.updates.length === 0) {
        return data(
          { error: "updates must be a non-empty array." },
          { status: 400 },
        );
      }

      const updates = payload.updates.filter(isValidTrackingUpdate);

      if (updates.length !== payload.updates.length) {
        return data(
          {
            error:
              "Each tracking update must include an orderNumber, carrier, and trackingNumber.",
          },
          { status: 400 },
        );
      }

      const response = await applyTracking(updates);
      return data(response, { status: 200 });
    } catch (error) {
      return data({ error: String(error) }, { status: 500 });
    }
  };
}
