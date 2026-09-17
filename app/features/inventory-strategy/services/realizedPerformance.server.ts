import { inventoryEconomicsRepository } from "~/core/db";
import { calculateInventoryEconomicsOrders } from "~/features/inventory-economics/services/inventoryEconomics.server";
import {
  summarizeRealizedPerformance,
  type RealizedPerformance,
  type SoldUnitLine,
} from "../domain/realizedPerformance";

export const PERFORMANCE_WINDOWS = [30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Realized performance for the seller: every sold unit under a current FIFO
 * allocation, priced at its share of the order's net proceeds and its lot's
 * current cost, summarized over the trailing windows.
 */
export async function loadRealizedPerformance(sellerKey: string, now = new Date()): Promise<RealizedPerformance> {
  const seller = sellerKey.trim();
  if (!seller) return summarizeRealizedPerformance([], { now, windowDays: PERFORMANCE_WINDOWS });
  const [evidence, soldUnits] = await Promise.all([
    inventoryEconomicsRepository.findWorkspaceEvidence(seller, 10_000),
    inventoryEconomicsRepository.findSoldUnits(seller),
  ]);
  const netByOrder = new Map(
    calculateInventoryEconomicsOrders(seller, evidence).map((order) => [order.orderNumber, order.reusableCashCents]),
  );
  const lines: SoldUnitLine[] = soldUnits.map((unit) => {
    const orderNet = netByOrder.get(unit.orderNumber);
    return {
      orderNumber: unit.orderNumber,
      soldAt: unit.soldAt.toISOString(),
      productLine: unit.productLine,
      quantity: unit.quantity,
      netProceedsCents: orderNet === undefined || unit.orderGrossCents <= 0
        ? null
        : Math.round(orderNet * (unit.grossCents / unit.orderGrossCents)),
      costCents: unit.costCents,
      daysHeld: Math.max(0, (unit.soldAt.getTime() - unit.heldSince.getTime()) / DAY_MS),
    };
  });
  return summarizeRealizedPerformance(lines, { now, windowDays: PERFORMANCE_WINDOWS });
}

export interface RealizedPerformanceLoadResult {
  report: RealizedPerformance | null;
  error: string | null;
}

export async function loadRealizedPerformanceWithRecovery(sellerKey: string): Promise<RealizedPerformanceLoadResult> {
  try {
    return { report: await loadRealizedPerformance(sellerKey), error: null };
  } catch (error) {
    console.error("Realized performance load failed", error);
    return { report: null, error: "Realized performance could not be loaded. Modeled strategy is still available." };
  }
}
