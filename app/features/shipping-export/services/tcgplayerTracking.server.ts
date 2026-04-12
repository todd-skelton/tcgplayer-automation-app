import { applyOrderTracking } from "~/integrations/tcgplayer/client/apply-order-tracking.server";
import type {
  ShippingTrackingApplyRequestItem,
  ShippingTrackingApplyResponse,
  ShippingTrackingApplyResult,
} from "../types/shippingExport";

type ApplyOrderTrackingFn = typeof applyOrderTracking;

function normalizeTrackingUpdates(
  updates: ShippingTrackingApplyRequestItem[],
): ShippingTrackingApplyRequestItem[] {
  const seenOrderNumbers = new Set<string>();

  return updates.filter((update) => {
    const normalizedOrderNumber = update.orderNumber.trim();

    if (!normalizedOrderNumber || seenOrderNumbers.has(normalizedOrderNumber)) {
      return false;
    }

    seenOrderNumbers.add(normalizedOrderNumber);
    return true;
  });
}

export async function applyTrackingToSellerOrders(
  updates: ShippingTrackingApplyRequestItem[],
  dependencies: {
    applyTracking?: ApplyOrderTrackingFn;
  } = {},
): Promise<ShippingTrackingApplyResponse> {
  const applyTracking = dependencies.applyTracking ?? applyOrderTracking;
  const normalizedUpdates = normalizeTrackingUpdates(updates);

  const results = await Promise.all(
    normalizedUpdates.map(async (update) => {
      try {
        await applyTracking(update.orderNumber, {
          carrier: update.carrier,
          trackingNumber: update.trackingNumber,
        });

        const result: ShippingTrackingApplyResult = {
          orderNumber: update.orderNumber,
          carrier: update.carrier,
          trackingNumber: update.trackingNumber,
          status: "applied",
        };

        return result;
      } catch (error) {
        const result: ShippingTrackingApplyResult = {
          orderNumber: update.orderNumber,
          carrier: update.carrier,
          trackingNumber: update.trackingNumber,
          status: "failed",
          error: String(error),
        };

        return result;
      }
    }),
  );

  return { results };
}
