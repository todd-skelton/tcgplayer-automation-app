import type { ShippingIntakeLineHistory, TcgPlayerShippingOrder } from "../types/shippingExport";
import { getOrderNumbersForShipmentReference } from "./shippingExportUtils";
import type { ShipmentToOrderMap } from "../types/shippingExport";
import { shippingInventorySkuId } from "./shippingOrderIdentity";

export interface IntakeComparison {
  soldTotal: number;
  comparableSoldTotal: number;
  intakeMarketTotal: number;
  orderedQuantity: number;
  matchedQuantity: number;
  priceKnownQuantity: number;
  dateKnownQuantity: number;
  recordedPriceQuantity: number;
  estimatedPriceQuantity: number;
  weightedDaysHeld: number | null;
  minimumDaysHeld: number | null;
  maximumDaysHeld: number | null;
  pendingLineCount: number;
  heldLineCount: number;
  mismatchLineCount: number;
  unavailableLineCount: number;
  lotCount: number;
}

const empty = (): IntakeComparison => ({
  soldTotal: 0,
  comparableSoldTotal: 0,
  intakeMarketTotal: 0,
  orderedQuantity: 0,
  matchedQuantity: 0,
  priceKnownQuantity: 0,
  dateKnownQuantity: 0,
  recordedPriceQuantity: 0,
  estimatedPriceQuantity: 0,
  weightedDaysHeld: null,
  minimumDaysHeld: null,
  maximumDaysHeld: null,
  pendingLineCount: 0,
  heldLineCount: 0,
  mismatchLineCount: 0,
  unavailableLineCount: 0,
  lotCount: 0,
});

function soldBySku(order: TcgPlayerShippingOrder) {
  const result = new Map<string, { quantity: number; soldTotal: number }>();
  for (const line of order.products ?? []) {
    const skuId = shippingInventorySkuId(line);
    if (!skuId) continue;
    const previous = result.get(skuId) ?? { quantity: 0, soldTotal: 0 };
    result.set(skuId, {
      quantity: previous.quantity + line.quantity,
      soldTotal: previous.soldTotal + line.quantity * line.unitPrice,
    });
  }
  return result;
}

function statusCount(comparison: IntakeComparison, line: ShippingIntakeLineHistory) {
  if (line.status === "pending") comparison.pendingLineCount += 1;
  if (line.status === "held") comparison.heldLineCount += 1;
  if (line.status === "mismatch") comparison.mismatchLineCount += 1;
  if (line.status === "unavailable") comparison.unavailableLineCount += 1;
}

export function compareOrderToIntake(order: TcgPlayerShippingOrder): IntakeComparison {
  const result = empty();
  result.soldTotal = order.products?.length
    ? order.products.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)
    : order["Value Of Products"];
  const sold = soldBySku(order);
  const historyLines = order.intakeHistory?.lines ?? [];
  result.orderedQuantity = order["Item Count"];
  if (!historyLines.length && result.orderedQuantity > 0) result.unavailableLineCount = 1;
  const historyQuantity = historyLines.reduce((sum, line) => sum + line.orderedQuantity, 0);
  const fallbackSoldPrice = historyQuantity ? result.soldTotal / historyQuantity : 0;
  for (const line of historyLines) {
    statusCount(result, line);
    if (line.status !== "current") continue;
    const sale = sold.get(line.skuId);
    const averageSoldPrice = sale?.quantity ? sale.soldTotal / sale.quantity
      : line.soldTotal !== null && line.orderedQuantity ? line.soldTotal / line.orderedQuantity : fallbackSoldPrice;
    result.matchedQuantity += line.matchedQuantity;
    result.priceKnownQuantity += line.priceKnownQuantity;
    result.dateKnownQuantity += line.dateKnownQuantity;
    result.recordedPriceQuantity += line.recordedPriceQuantity;
    result.estimatedPriceQuantity += line.estimatedPriceQuantity;
    result.comparableSoldTotal += averageSoldPrice * line.priceKnownQuantity;
    result.intakeMarketTotal += line.intakeMarketTotal ?? 0;
    result.lotCount += line.lots.length;
    if (line.weightedDaysHeld !== null) {
      const previousWeight = result.dateKnownQuantity - line.dateKnownQuantity;
      result.weightedDaysHeld = ((result.weightedDaysHeld ?? 0) * previousWeight
        + line.weightedDaysHeld * line.dateKnownQuantity) / result.dateKnownQuantity;
    }
    if (line.minimumDaysHeld !== null) result.minimumDaysHeld = result.minimumDaysHeld === null
      ? line.minimumDaysHeld : Math.min(result.minimumDaysHeld, line.minimumDaysHeld);
    if (line.maximumDaysHeld !== null) result.maximumDaysHeld = result.maximumDaysHeld === null
      ? line.maximumDaysHeld : Math.max(result.maximumDaysHeld, line.maximumDaysHeld);
  }
  return result;
}

export function sumIntakeComparisons(comparisons: IntakeComparison[]): IntakeComparison {
  const result = empty();
  let weightedAgeTotal = 0;
  for (const comparison of comparisons) {
    result.soldTotal += comparison.soldTotal;
    result.comparableSoldTotal += comparison.comparableSoldTotal;
    result.intakeMarketTotal += comparison.intakeMarketTotal;
    result.orderedQuantity += comparison.orderedQuantity;
    result.matchedQuantity += comparison.matchedQuantity;
    result.priceKnownQuantity += comparison.priceKnownQuantity;
    result.dateKnownQuantity += comparison.dateKnownQuantity;
    result.recordedPriceQuantity += comparison.recordedPriceQuantity;
    result.estimatedPriceQuantity += comparison.estimatedPriceQuantity;
    result.pendingLineCount += comparison.pendingLineCount;
    result.heldLineCount += comparison.heldLineCount;
    result.mismatchLineCount += comparison.mismatchLineCount;
    result.unavailableLineCount += comparison.unavailableLineCount;
    result.lotCount += comparison.lotCount;
    if (comparison.weightedDaysHeld !== null) weightedAgeTotal += comparison.weightedDaysHeld * comparison.dateKnownQuantity;
    if (comparison.minimumDaysHeld !== null) result.minimumDaysHeld = result.minimumDaysHeld === null
      ? comparison.minimumDaysHeld : Math.min(result.minimumDaysHeld, comparison.minimumDaysHeld);
    if (comparison.maximumDaysHeld !== null) result.maximumDaysHeld = result.maximumDaysHeld === null
      ? comparison.maximumDaysHeld : Math.max(result.maximumDaysHeld, comparison.maximumDaysHeld);
  }
  result.weightedDaysHeld = result.dateKnownQuantity ? weightedAgeTotal / result.dateKnownQuantity : null;
  return result;
}

export function compareOrdersToIntake(orders: TcgPlayerShippingOrder[]): IntakeComparison {
  const unique = [...new Map(orders.map((order) => [order["Order #"], order])).values()];
  return sumIntakeComparisons(unique.map(compareOrderToIntake));
}

export function compareShipmentToIntake(
  sourceOrders: TcgPlayerShippingOrder[],
  shipmentToOrderMap: ShipmentToOrderMap,
  shipmentReference: string,
): IntakeComparison {
  const orderNumbers = new Set(getOrderNumbersForShipmentReference(shipmentToOrderMap, shipmentReference));
  return compareOrdersToIntake(sourceOrders.filter((order) => orderNumbers.has(order["Order #"])));
}

export function intakeDeltaAmount(comparison: IntakeComparison): number | null {
  return comparison.priceKnownQuantity ? comparison.comparableSoldTotal - comparison.intakeMarketTotal : null;
}

export function intakeDeltaPercent(comparison: IntakeComparison): number | null {
  const amount = intakeDeltaAmount(comparison);
  return amount === null || comparison.intakeMarketTotal === 0 ? null : amount / comparison.intakeMarketTotal * 100;
}
