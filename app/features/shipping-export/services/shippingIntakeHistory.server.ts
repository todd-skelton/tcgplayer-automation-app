import { inventoryFifoRepository } from "~/core/db";
import type {
  ShippingIntakeHistoryStatus,
  ShippingIntakeLineHistory,
  ShippingIntakeLot,
  ShippingIntakePriceProvenance,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";
import { shippingInventorySkuId } from "./shippingOrderIdentity";

type AllocationRow = {
  orderNumber: string;
  currentOrderTime: Date;
  allocatedOrderTime: Date | null;
  currentSourceOrderRevision: number;
  skuId: string;
  currentOrderedQuantity: number;
  persistedSoldTotal: number;
  state: string | null;
  holdReason: string | null;
  allocatedOrderedQuantity: number | null;
  matchedQuantity: number | null;
  unmatchedQuantity: number | null;
  priceKnownQuantity: number | null;
  dateKnownQuantity: number | null;
  intakeMarketTotal: number | null;
  weightedDaysHeld: number | null;
  revisionId: string | null;
  allocatedSourceOrderRevision: number | null;
  replayStatus: string | null;
  queueHoldReason: string | null;
  allocationPending: boolean;
  lots: Array<{
    supplyKey: string;
    receiptId: number;
    quantity: number;
    availableAt: string;
    dispositionId: string | null;
    quantityCorrectionId: string | null;
    receiptKind: "opening_balance" | "received";
    intakeAt: string | null;
    marketValue: number | null;
    marketProvenance: string;
    marketCalculatedAt: string | null;
  }>;
};

type FindAllocations = typeof inventoryFifoRepository.findShippingOrderAllocations;

const MAX_ORDERS = 500;

function groupedShippingLines(order: TcgPlayerShippingOrder) {
  const grouped = new Map<string, { quantity: number; soldTotal: number }>();
  for (const line of order.products ?? []) {
    const skuId = shippingInventorySkuId(line);
    if (!skuId) continue;
    const previous = grouped.get(skuId) ?? { quantity: 0, soldTotal: 0 };
    grouped.set(skuId, {
      quantity: previous.quantity + line.quantity,
      soldTotal: previous.soldTotal + line.unitPrice * line.quantity,
    });
  }
  return grouped;
}

function unidentifiedShippingQuantity(order: TcgPlayerShippingOrder): number {
  if (!order.products?.length) return 0;
  const productQuantity = order.products.reduce((sum, line) => sum + line.quantity, 0);
  const unidentified = order.products.filter((line) => !shippingInventorySkuId(line)).reduce((sum, line) => sum + line.quantity, 0);
  return unidentified + Math.max(0, order["Item Count"] - productQuantity);
}

function priceProvenance(lot: AllocationRow["lots"][number]): ShippingIntakePriceProvenance {
  if (lot.marketValue === null) return "unknown";
  return /estimated|modeled|calculated/i.test(lot.marketProvenance) ? "estimated" : "recorded";
}

function unavailableLine(skuId: string, order: TcgPlayerShippingOrder, quantity: number): ShippingIntakeLineHistory {
  return {
    skuId,
    status: "unavailable",
    statusReason: "No exact persisted seller-order allocation is available.",
    allocationRevisionId: null,
    allocatedSourceOrderRevision: null,
    currentSourceOrderRevision: 0,
    orderTime: order["Order Date"],
    orderedQuantity: quantity,
    soldTotal: null,
    matchedQuantity: 0,
    unmatchedQuantity: quantity,
    priceKnownQuantity: 0,
    dateKnownQuantity: 0,
    recordedPriceQuantity: 0,
    estimatedPriceQuantity: 0,
    intakeMarketTotal: null,
    weightedDaysHeld: null,
    minimumDaysHeld: null,
    maximumDaysHeld: null,
    lots: [],
  };
}

function historyStatus(row: AllocationRow, shippingQuantity: number): {
  status: ShippingIntakeHistoryStatus;
  reason?: string;
} {
  if (row.currentOrderedQuantity !== shippingQuantity) {
    return { status: "mismatch", reason: `Shipping has ${shippingQuantity} units; order history has ${row.currentOrderedQuantity}.` };
  }
  if (row.state === "held" || row.replayStatus === "held") {
    return { status: "held", reason: row.queueHoldReason ?? row.holdReason ?? "FIFO allocation needs review." };
  }
  if (row.allocationPending || !row.revisionId || row.replayStatus === "pending" || row.replayStatus === "processing") {
    return { status: "pending", reason: "FIFO allocation is waiting to be refreshed." };
  }
  if (row.state === "unsupported") {
    return { status: "unavailable", reason: "This inventory identity is not a supported standard SKU." };
  }
  return { status: "current" };
}

function currentLineHistory(row: AllocationRow, shippingQuantity: number): ShippingIntakeLineHistory {
  let state = historyStatus(row, shippingQuantity);
  const allocationTime = row.allocatedOrderTime ?? row.currentOrderTime;
  const orderTime = allocationTime.toISOString();
  const lots: ShippingIntakeLot[] = row.lots.map((lot) => {
    const intakeAt = lot.intakeAt ? new Date(lot.intakeAt) : null;
    const daysHeld = intakeAt && intakeAt <= allocationTime
      ? (allocationTime.getTime() - intakeAt.getTime()) / 86_400_000
      : null;
    return {
      supplyKey: lot.supplyKey,
      receiptId: lot.receiptId,
      quantity: lot.quantity,
      availableAt: new Date(lot.availableAt).toISOString(),
      sourceKind: lot.dispositionId ? "physical_restock" : lot.quantityCorrectionId ? "quantity_correction" : lot.receiptKind,
      intakeAt: intakeAt?.toISOString() ?? null,
      daysHeld,
      intakeMarketValue: lot.marketValue,
      priceProvenance: priceProvenance(lot),
    };
  });
  const priceKnownLots = lots.filter((lot) => lot.intakeMarketValue !== null);
  const dateKnownLots = lots.filter((lot) => lot.daysHeld !== null);
  const dateValues = dateKnownLots.map((lot) => lot.daysHeld as number);
  const priceKnownQuantity = priceKnownLots.reduce((sum, lot) => sum + lot.quantity, 0);
  const dateKnownQuantity = dateKnownLots.reduce((sum, lot) => sum + lot.quantity, 0);
  const derivedIntakeMarketTotal = priceKnownQuantity
    ? priceKnownLots.reduce((sum, lot) => sum + (lot.intakeMarketValue as number) * lot.quantity, 0)
    : null;
  const recordedPriceQuantity = lots.filter((lot) => lot.priceProvenance === "recorded").reduce((sum, lot) => sum + lot.quantity, 0);
  const estimatedPriceQuantity = lots.filter((lot) => lot.priceProvenance === "estimated").reduce((sum, lot) => sum + lot.quantity, 0);
  const aggregateMismatch = lots.reduce((sum, lot) => sum + lot.quantity, 0) !== (row.matchedQuantity ?? 0)
    || priceKnownQuantity !== (row.priceKnownQuantity ?? 0) || dateKnownQuantity !== (row.dateKnownQuantity ?? 0)
    || (derivedIntakeMarketTotal === null) !== (row.intakeMarketTotal === null)
    || (derivedIntakeMarketTotal !== null && Math.round(derivedIntakeMarketTotal * 100) !== Math.round((row.intakeMarketTotal ?? 0) * 100));
  if (aggregateMismatch) state = { status: "mismatch", reason: "Saved FIFO totals do not match their receipt allocation detail." };

  return {
    skuId: row.skuId,
    status: state.status,
    ...(state.reason ? { statusReason: state.reason } : {}),
    allocationRevisionId: row.revisionId,
    allocatedSourceOrderRevision: row.allocatedSourceOrderRevision,
    currentSourceOrderRevision: row.currentSourceOrderRevision,
    orderTime,
    orderedQuantity: shippingQuantity,
    soldTotal: row.persistedSoldTotal,
    matchedQuantity: row.matchedQuantity ?? 0,
    unmatchedQuantity: row.unmatchedQuantity ?? shippingQuantity,
    priceKnownQuantity: row.priceKnownQuantity ?? 0,
    dateKnownQuantity: row.dateKnownQuantity ?? 0,
    recordedPriceQuantity,
    estimatedPriceQuantity,
    intakeMarketTotal: row.intakeMarketTotal,
    weightedDaysHeld: row.weightedDaysHeld,
    minimumDaysHeld: dateValues.length ? Math.min(...dateValues) : null,
    maximumDaysHeld: dateValues.length ? Math.max(...dateValues) : null,
    lots,
  };
}

export async function enrichShippingOrdersWithIntakeHistory(
  orders: TcgPlayerShippingOrder[],
  sellerKey: string,
  findAllocations: FindAllocations = inventoryFifoRepository.findShippingOrderAllocations,
): Promise<TcgPlayerShippingOrder[]> {
  const uniqueOrders = [...new Map(orders.map((order) => [order["Order #"], order])).values()];
  if (uniqueOrders.length > MAX_ORDERS) throw new Error(`Intake history is limited to ${MAX_ORDERS} orders per request.`);
  const rows = await findAllocations(sellerKey, uniqueOrders.map((order) => order["Order #"])) as AllocationRow[];
  const rowsByOrder = new Map<string, Map<string, AllocationRow>>();
  for (const row of rows) {
    const bySku = rowsByOrder.get(row.orderNumber) ?? new Map<string, AllocationRow>();
    bySku.set(row.skuId, row);
    rowsByOrder.set(row.orderNumber, bySku);
  }
  const refreshedAt = new Date().toISOString();
  return orders.map((order) => {
    const grouped = groupedShippingLines(order);
    const persisted = rowsByOrder.get(order["Order #"]);
    const lines = grouped.size
      ? [...grouped.entries()].map(([skuId, values]) => {
        const row = persisted?.get(skuId);
        return row ? currentLineHistory(row, values.quantity) : unavailableLine(skuId, order, values.quantity);
      })
      : [...(persisted?.values() ?? [])].map((row) => currentLineHistory(row, row.currentOrderedQuantity));
    const unidentifiedQuantity = unidentifiedShippingQuantity(order);
    if (unidentifiedQuantity) lines.push(unavailableLine("unidentified", order, unidentifiedQuantity));
    if (!order.products?.length) {
      const persistedQuantity = lines.reduce((sum, line) => sum + line.orderedQuantity, 0);
      const persistedSoldTotal = lines.reduce((sum, line) => sum + (line.soldTotal ?? 0), 0);
      if (persistedQuantity < order["Item Count"]) {
        lines.push(unavailableLine("unidentified", order, order["Item Count"] - persistedQuantity));
      }
      if (persistedQuantity > order["Item Count"]
        || (persistedQuantity === order["Item Count"]
          && Math.round(persistedSoldTotal * 100) !== Math.round(order["Value Of Products"] * 100))) {
        for (const line of lines) {
          line.status = "mismatch";
          line.statusReason = "Persisted SKU quantities or sale proceeds do not match the shipping order total.";
        }
      }
    }
    if (!lines.length && order["Item Count"] > 0) lines.push(unavailableLine("unidentified", order, order["Item Count"]));
    return { ...order, intakeHistory: { orderNumber: order["Order #"], sellerKey: sellerKey.trim(), lines, refreshedAt } };
  });
}

export function clearShippingIntakeHistory(orders: TcgPlayerShippingOrder[]): TcgPlayerShippingOrder[] {
  return orders.map(({ intakeHistory: _history, ...order }) => order);
}
