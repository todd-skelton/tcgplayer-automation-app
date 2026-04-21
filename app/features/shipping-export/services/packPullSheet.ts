import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import { getOrderNumbersForShipmentReference } from "./shippingExportUtils";
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

type ParsedOrderQuantityEntry = {
  orderNumber: string;
  quantity: number;
};

function clonePullSheetItem(
  item: PullSheetItem,
  quantity: number,
): PullSheetItem {
  return {
    ...item,
    quantity,
  };
}

function getShipmentOrderItems(
  shipmentReference: string,
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentToOrderMap: ShipmentToOrderMap,
): OrderLineItem[] {
  const orderNumbers = getOrderNumbersForShipmentReference(
    shipmentToOrderMap,
    shipmentReference,
  );

  return orderNumbers
    .map((orderNumber) =>
      sourceOrders.find((order) => order["Order #"] === orderNumber),
    )
    .flatMap((order) => order?.products ?? []);
}

function parsePullSheetOrderQuantity(
  orderQuantity: string,
): ParsedOrderQuantityEntry[] | null {
  const normalizedValue = orderQuantity.trim();

  if (!normalizedValue) {
    return null;
  }

  const entries = normalizedValue
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return null;
  }

  const parsedEntries: ParsedOrderQuantityEntry[] = [];

  for (const entry of entries) {
    const quantitySeparatorIndex = entry.lastIndexOf(":");

    if (
      quantitySeparatorIndex <= 0 ||
      quantitySeparatorIndex === entry.length - 1
    ) {
      return null;
    }

    const orderNumber = entry.slice(0, quantitySeparatorIndex).trim();
    const quantityValue = entry.slice(quantitySeparatorIndex + 1).trim();
    const quantity = Number.parseInt(quantityValue, 10);

    if (!orderNumber || !Number.isInteger(quantity) || quantity <= 0) {
      return null;
    }

    parsedEntries.push({ orderNumber, quantity });
  }

  return parsedEntries;
}

function getShipmentPullSheetItems(
  pullSheetItems: PullSheetItem[],
  shipmentOrderNumbers: Set<string>,
): {
  items: PullSheetItem[];
  matchedQuantity: number;
  hasOrderQuantityIssue: boolean;
} {
  const shipmentItems: PullSheetItem[] = [];
  let matchedQuantity = 0;
  let hasOrderQuantityIssue = false;

  for (const item of pullSheetItems) {
    const parsedEntries = parsePullSheetOrderQuantity(item.orderQuantity);

    if (!parsedEntries) {
      hasOrderQuantityIssue = true;
      continue;
    }

    const shipmentQuantity = parsedEntries.reduce((sum, entry) => {
      return shipmentOrderNumbers.has(entry.orderNumber)
        ? sum + entry.quantity
        : sum;
    }, 0);

    if (shipmentQuantity <= 0) {
      continue;
    }

    matchedQuantity += shipmentQuantity;
    shipmentItems.push(clonePullSheetItem(item, shipmentQuantity));
  }

  return {
    items: shipmentItems,
    matchedQuantity,
    hasOrderQuantityIssue,
  };
}

export function getPullSheetItemsForOrder(
  pullSheetItems: PullSheetItem[],
  orderNumber: string,
): PullSheetItem[] {
  const normalizedOrderNumber = orderNumber.trim();

  if (!normalizedOrderNumber) {
    return [];
  }

  return pullSheetItems.flatMap((item) => {
    const parsedEntries = parsePullSheetOrderQuantity(item.orderQuantity);

    if (!parsedEntries) {
      return [];
    }

    const orderQuantity = parsedEntries.reduce((sum, entry) => {
      return entry.orderNumber === normalizedOrderNumber
        ? sum + entry.quantity
        : sum;
    }, 0);

    return orderQuantity > 0 ? [clonePullSheetItem(item, orderQuantity)] : [];
  });
}

export function allocatePullSheetItemsToShipments(
  shipmentReferences: string[],
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentToOrderMap: ShipmentToOrderMap,
  pullSheetItems: PullSheetItem[],
): Record<string, PackPullSheetShipmentMatch> {
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

      const shipmentOrderNumbers = new Set(
        getOrderNumbersForShipmentReference(
          shipmentToOrderMap,
          shipmentReference,
        ).map(
          (orderNumber) => orderNumber.trim(),
        ),
      );
      const shipmentPullSheetItems = getShipmentPullSheetItems(
        pullSheetItems,
        shipmentOrderNumbers,
      );
      const matchedItems = shipmentPullSheetItems.items;
      const matchedQuantity = shipmentPullSheetItems.matchedQuantity;

      let fallbackReason: string | null = null;

      if (shipmentPullSheetItems.hasOrderQuantityIssue) {
        fallbackReason =
          "Pull sheet order data was missing or malformed for this shipment.";
      } else if (matchedQuantity !== expectedQuantity) {
        fallbackReason =
          "Visual pull sheet matching was incomplete for this shipment.";
      }

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
