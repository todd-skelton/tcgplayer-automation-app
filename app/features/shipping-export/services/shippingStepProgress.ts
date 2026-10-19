/** The outbound shipping workflow, in the order the operator works through it. */
export const OUTBOUND_STEPS = [
  { key: "load-orders", label: "Load Orders" },
  { key: "pull-sheet", label: "Pull Sheet" },
  { key: "buy-postage", label: "Buy Postage" },
  { key: "print", label: "Print" },
  { key: "pack", label: "Pack" },
  { key: "apply-tracking", label: "Apply Tracking" },
  { key: "notify", label: "Notify" },
] as const;

export type ShippingStepKey = (typeof OUTBOUND_STEPS)[number]["key"];

/** The counts the workflow already knows, from which each step's standing is described. */
export interface ShippingWorkflowCounts {
  orderCount: number;
  isLoadingOrders: boolean;
  itemCount: number;
  shipmentCount: number;
  purchasedCount: number;
  packedCount: number;
  trackingReadyCount: number;
  alreadyTrackedCount: number;
  messageReadyCount: number;
  alreadySentCount: number;
}

/** Where the current step stands and whether the workflow may move past it. */
export interface ShippingStepProgress {
  /** One line such as "3 of 5 shipments packed". */
  summary: string;
  /** False while the step still has work that Continue should wait for. */
  readyToContinue: boolean;
  /** Whether the operator may deliberately move on before the step is ready. */
  canSkip: boolean;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function describeShippingStep(
  step: ShippingStepKey,
  counts: ShippingWorkflowCounts,
): ShippingStepProgress {
  switch (step) {
    case "load-orders":
      return {
        summary: counts.isLoadingOrders
          ? "Loading orders..."
          : counts.orderCount > 0
            ? `${count(counts.orderCount, "order")} loaded`
            : "No orders loaded",
        readyToContinue: counts.orderCount > 0 && !counts.isLoadingOrders,
        canSkip: false,
      };
    case "pull-sheet":
      return {
        summary: `${count(counts.itemCount, "card")} to pull for ${count(counts.orderCount, "order")}`,
        readyToContinue: true,
        canSkip: false,
      };
    case "buy-postage":
      return {
        summary: `Postage bought for ${counts.purchasedCount} of ${count(counts.shipmentCount, "shipment")}`,
        readyToContinue: counts.shipmentCount > 0 && counts.purchasedCount === counts.shipmentCount,
        canSkip: counts.shipmentCount > 0,
      };
    case "print":
      return {
        summary: `${count(counts.purchasedCount, "label")} ready to print`,
        readyToContinue: true,
        canSkip: false,
      };
    case "pack":
      return {
        summary: `${counts.packedCount} of ${count(counts.shipmentCount, "shipment")} packed`,
        readyToContinue: counts.packedCount > 0,
        canSkip: true,
      };
    case "apply-tracking":
      return {
        summary:
          counts.trackingReadyCount > 0
            ? `${count(counts.trackingReadyCount, "order")} ready for tracking`
            : counts.alreadyTrackedCount > 0
              ? "Tracking applied to every order with production postage"
              : "No orders have production postage",
        readyToContinue: counts.trackingReadyCount === 0,
        canSkip: true,
      };
    case "notify":
      return {
        summary:
          counts.messageReadyCount > 0
            ? `${count(counts.messageReadyCount, "order")} ready for shipped messages`
            : counts.alreadySentCount > 0
              ? "Every order with production postage has its shipped message"
              : "No orders are ready for shipped messages",
        readyToContinue: true,
        canSkip: false,
      };
  }
}
