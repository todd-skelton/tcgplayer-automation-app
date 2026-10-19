/** The outbound shipping workflow, in the order the operator works through it. */
export const OUTBOUND_STEPS = [
  { key: "load-orders", label: "Load Orders" },
  { key: "pull-sheet", label: "Pull Sheet" },
  { key: "buy-postage", label: "Buy Postage" },
  { key: "print", label: "Print" },
  { key: "pack", label: "Pack" },
  { key: "ship", label: "Ship" },
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
  /** Orders that still need tracking applied or a shipped message sent. */
  shipPendingCount: number;
  /** Orders with production postage that are tracked and messaged. */
  shippedCount: number;
  /** Buyers can only be messaged with a seller key. */
  hasSellerKey: boolean;
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
    case "ship":
      return {
        summary:
          counts.shipPendingCount > 0 && !counts.hasSellerKey
            ? "Set the seller key to notify buyers"
            : counts.shipPendingCount > 0
              ? `${count(counts.shipPendingCount, "order")} to mark shipped and notify`
              : counts.shippedCount > 0
                ? "Every order is shipped and its buyer notified"
                : "No orders have production postage",
        readyToContinue: true,
        canSkip: false,
      };
  }
}
