import { useEffect, useMemo, useState } from "react";
import { readResponseError } from "~/core/utils/readJsonResponse";
import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import { loadPullSheetItemsFromCsvText } from "~/features/pull-sheet/utils/pullSheetItems";
import {
  allocatePullSheetItemsToShipments,
  type PackPullSheetLoadStatus,
} from "../services/packPullSheet";
import type { ShipmentToOrderMap, TcgPlayerShippingOrder } from "../types/shippingExport";

type PullSheetState = {
  orderNumbersKey: string;
  status: "ready" | "error";
  items: PullSheetItem[];
  orderIds: string[];
  error: string | null;
};

const EMPTY_ITEMS: PullSheetItem[] = [];
const EMPTY_ORDER_IDS: string[] = [];

/** Remote rows belong to an ordered set of orders, independent of intake history. */
export function useShippingPullSheet(
  orderNumbers: string[],
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentReferences: string[],
  shipmentToOrderMap: ShipmentToOrderMap,
) {
  const orderNumbersKey = JSON.stringify(orderNumbers);
  const [state, setState] = useState<PullSheetState | null>(null);

  useEffect(() => {
    const requestedOrderNumbers: string[] = JSON.parse(orderNumbersKey);
    if (requestedOrderNumbers.length === 0) {
      setState(null);
      return;
    }

    let isActive = true;
    const controller = new AbortController();
    setState(null);

    void (async () => {
      try {
        const response = await fetch("/api/shipping-export/pull-sheet-export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderNumbers: requestedOrderNumbers,
            timezoneOffset: -new Date().getTimezoneOffset() / 60,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            await readResponseError(response, "Failed to generate pull sheet export."),
          );
        }
        const csvText = await response.text();
        if (!isActive) return;
        const result = await loadPullSheetItemsFromCsvText(csvText);
        if (isActive) {
          setState({
            orderNumbersKey,
            status: "ready",
            items: result.items,
            orderIds: result.orderIds,
            error: null,
          });
        }
      } catch (error) {
        if (isActive) {
          setState({
            orderNumbersKey,
            status: "error",
            items: EMPTY_ITEMS,
            orderIds: EMPTY_ORDER_IDS,
            error: String(error),
          });
        }
      }
    })();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [orderNumbersKey]);

  const current = state?.orderNumbersKey === orderNumbersKey ? state : null;
  const status: PackPullSheetLoadStatus =
    orderNumbers.length === 0 ? "idle" : current?.status ?? "loading";
  const pullSheetItems = current?.items ?? EMPTY_ITEMS;
  const hasProductData = sourceOrders.some((order) => (order.products?.length ?? 0) > 0);

  // Recompute local matches when order metadata changes without unloading the rows.
  const packPullSheetMatchesByReference = useMemo(
    () =>
      hasProductData && status === "ready"
        ? allocatePullSheetItemsToShipments(
            shipmentReferences,
            sourceOrders,
            shipmentToOrderMap,
            pullSheetItems,
          )
        : {},
    [hasProductData, status, shipmentReferences, sourceOrders, shipmentToOrderMap, pullSheetItems],
  );

  return {
    isGeneratingPullSheet: status === "loading",
    pullSheetItems,
    pullSheetOrderIds: current?.orderIds ?? EMPTY_ORDER_IDS,
    pullSheetError: current?.error ?? null,
    packPullSheetStatus: hasProductData ? status : "idle",
    packPullSheetError: hasProductData ? current?.error ?? null : null,
    packPullSheetMatchesByReference,
  };
}
