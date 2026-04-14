import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import type {
  OrderLineItem,
  ShipmentToOrderMap,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";

export type PackPullSheetLoadStatus = "idle" | "loading" | "ready" | "error";

export interface PackPullSheetShipmentMatch {
  canRenderGrid: boolean;
  fallbackReason: string | null;
  expectedQuantity: number;
  matchedQuantity: number;
  items: PullSheetItem[];
}

type PullSheetPoolEntry = {
  item: PullSheetItem;
  remainingQuantity: number;
};

function normalizeProductName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function clonePullSheetItem(
  item: PullSheetItem,
  quantity: number,
): PullSheetItem {
  return {
    ...item,
    quantity,
  };
}

function getShipmentReferences(
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentToOrderMap: ShipmentToOrderMap,
): string[] {
  const mappedReferences = Object.keys(shipmentToOrderMap);

  if (mappedReferences.length > 0) {
    return mappedReferences;
  }

  return sourceOrders.map((order) => order["Order #"]);
}

function getShipmentOrderItems(
  shipmentReference: string,
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentToOrderMap: ShipmentToOrderMap,
): OrderLineItem[] {
  const orderNumbers = shipmentToOrderMap[shipmentReference] ?? [shipmentReference];

  return orderNumbers
    .map((orderNumber) =>
      sourceOrders.find((order) => order["Order #"] === orderNumber),
    )
    .flatMap((order) => order?.products ?? []);
}

function buildPullSheetPools(pullSheetItems: PullSheetItem[]) {
  const skuPool = new Map<number, PullSheetPoolEntry[]>();
  const namePool = new Map<string, PullSheetPoolEntry[]>();

  pullSheetItems.forEach((item) => {
    const poolEntry: PullSheetPoolEntry = {
      item,
      remainingQuantity: item.quantity,
    };

    const skuEntries = skuPool.get(item.skuId) ?? [];
    skuEntries.push(poolEntry);
    skuPool.set(item.skuId, skuEntries);

    const normalizedName = normalizeProductName(item.productName);
    const nameEntries = namePool.get(normalizedName) ?? [];
    nameEntries.push(poolEntry);
    namePool.set(normalizedName, nameEntries);
  });

  return { skuPool, namePool };
}

function allocateFromPool(
  poolEntries: PullSheetPoolEntry[],
  quantity: number,
): PullSheetItem[] | null {
  const remaining = poolEntries.reduce(
    (sum, entry) => sum + entry.remainingQuantity,
    0,
  );

  if (remaining < quantity) {
    return null;
  }

  const allocated: PullSheetItem[] = [];
  let quantityLeft = quantity;

  for (const entry of poolEntries) {
    if (quantityLeft <= 0) {
      break;
    }

    if (entry.remainingQuantity <= 0) {
      continue;
    }

    const takeQuantity = Math.min(entry.remainingQuantity, quantityLeft);
    entry.remainingQuantity -= takeQuantity;
    quantityLeft -= takeQuantity;
    allocated.push(clonePullSheetItem(entry.item, takeQuantity));
  }

  return quantityLeft === 0 ? allocated : null;
}

export function allocatePullSheetItemsToShipments(
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentToOrderMap: ShipmentToOrderMap,
  pullSheetItems: PullSheetItem[],
): Record<string, PackPullSheetShipmentMatch> {
  const shipmentReferences = getShipmentReferences(sourceOrders, shipmentToOrderMap);
  const { skuPool, namePool } = buildPullSheetPools(pullSheetItems);

  return Object.fromEntries(
    shipmentReferences.map((shipmentReference) => {
      const orderItems = getShipmentOrderItems(
        shipmentReference,
        sourceOrders,
        shipmentToOrderMap,
      );
      const expectedQuantity = orderItems.reduce(
        (sum, item) => sum + item.quantity,
        0,
      );

      if (orderItems.length === 0) {
        return [
          shipmentReference,
          {
            canRenderGrid: false,
            fallbackReason: "Line item details unavailable for this shipment.",
            expectedQuantity,
            matchedQuantity: 0,
            items: [],
          } satisfies PackPullSheetShipmentMatch,
        ];
      }

      const matchedItems: PullSheetItem[] = [];
      let fallbackReason: string | null = null;

      for (const orderItem of orderItems) {
        let allocatedItems: PullSheetItem[] | null = null;

        if (orderItem.skuId) {
          allocatedItems = allocateFromPool(
            skuPool.get(orderItem.skuId) ?? [],
            orderItem.quantity,
          );
        } else {
          const normalizedName = normalizeProductName(orderItem.name);
          const poolEntries = (namePool.get(normalizedName) ?? []).filter(
            (entry) => entry.remainingQuantity > 0,
          );
          const distinctSkuIds = new Set(poolEntries.map((entry) => entry.item.skuId));

          if (distinctSkuIds.size > 1) {
            fallbackReason = `Visual pull sheet matching was ambiguous for ${orderItem.name}.`;
            break;
          }

          allocatedItems = allocateFromPool(poolEntries, orderItem.quantity);
        }

        if (!allocatedItems) {
          fallbackReason = `Visual pull sheet matching was incomplete for ${orderItem.name}.`;
          break;
        }

        matchedItems.push(...allocatedItems);
      }

      const matchedQuantity = matchedItems.reduce(
        (sum, item) => sum + item.quantity,
        0,
      );

      return [
        shipmentReference,
        {
          canRenderGrid:
            fallbackReason === null &&
            matchedItems.length > 0 &&
            matchedQuantity === expectedQuantity,
          fallbackReason,
          expectedQuantity,
          matchedQuantity,
          items: matchedItems,
        } satisfies PackPullSheetShipmentMatch,
      ];
    }),
  );
}
