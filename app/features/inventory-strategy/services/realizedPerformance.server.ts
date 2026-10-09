import { inventoryBatchPricingJobsRepository, inventoryEconomicsRepository } from "~/core/db";
import { calculateInventoryEconomicsOrders } from "~/features/inventory-economics/services/inventoryEconomics.server";
import { MARGIN_TREND_WEEKS, summarizeMarginTrend, type MarginTrend } from "../domain/marginTrend";
import { describePricingChanges, type PricingConfigurationUse } from "../domain/pricingChanges";
import {
  PERFORMANCE_WINDOWS,
  summarizeRealizedPerformance,
  type RealizedPerformance,
  type SoldUnitLine,
} from "../domain/realizedPerformance";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far before the trend pricing history is read, so its first change has a configuration to compare with. */
const PRICING_HISTORY_LEAD_DAYS = 56;

/**
 * Every sold unit under a current FIFO allocation, priced at its share of the
 * order's net proceeds and its lot's current cost.
 */
async function loadSoldUnitLines(sellerKey: string): Promise<SoldUnitLine[]> {
  const seller = sellerKey.trim();
  if (!seller) return [];
  const [evidence, soldUnits] = await Promise.all([
    inventoryEconomicsRepository.findWorkspaceEvidence(seller, 10_000),
    inventoryEconomicsRepository.findSoldUnits(seller),
  ]);
  const netByOrder = new Map(
    calculateInventoryEconomicsOrders(seller, evidence).map((order) => [order.orderNumber, order.reusableCashCents]),
  );
  return soldUnits.map((unit) => {
    const orderNet = netByOrder.get(unit.orderNumber);
    return {
      orderNumber: unit.orderNumber,
      soldAt: unit.soldAt.toISOString(),
      productLine: unit.productLine,
      quantity: unit.quantity,
      grossCents: unit.grossCents,
      netProceedsCents: orderNet === undefined || unit.orderGrossCents <= 0
        ? null
        : Math.round(orderNet * (unit.grossCents / unit.orderGrossCents)),
      costCents: unit.costCents,
      daysHeld: Math.max(0, (unit.soldAt.getTime() - unit.heldSince.getTime()) / DAY_MS),
      intakeMarketCents: unit.intakeMarketCents,
      saleMarketCents: unit.saleMarketCents,
    };
  });
}

async function loadPricingHistory(since: Date): Promise<PricingConfigurationUse[]> {
  try {
    const history = await inventoryBatchPricingJobsRepository.findPricingConfigurationHistory(since);
    return history.map((use) => ({ ...use, firstPricedAt: use.firstPricedAt.toISOString() }));
  } catch (error) {
    console.error("Pricing change history load failed", error);
    return [];
  }
}

/**
 * Realized performance for the seller over the trailing windows, and its
 * margin week by week beside the days pricing changed.
 */
export async function loadRealizedPerformance(
  sellerKey: string,
  now = new Date(),
): Promise<{ report: RealizedPerformance; marginTrend: MarginTrend }> {
  const [lines, pricingHistory] = await Promise.all([
    loadSoldUnitLines(sellerKey),
    loadPricingHistory(new Date(now.getTime() - (MARGIN_TREND_WEEKS * 7 + PRICING_HISTORY_LEAD_DAYS) * DAY_MS)),
  ]);
  const weeks = summarizeMarginTrend(lines, { now });
  return {
    report: summarizeRealizedPerformance(lines, { now, windowDays: PERFORMANCE_WINDOWS }),
    marginTrend: { weeks, pricingChanges: weeks.length ? describePricingChanges(pricingHistory, weeks[0].weekStart) : [] },
  };
}

export interface RealizedPerformanceLoadResult {
  report: RealizedPerformance | null;
  marginTrend: MarginTrend | null;
  error: string | null;
}

export async function loadRealizedPerformanceWithRecovery(sellerKey: string): Promise<RealizedPerformanceLoadResult> {
  try {
    return { ...await loadRealizedPerformance(sellerKey), error: null };
  } catch (error) {
    console.error("Realized performance load failed", error);
    return { report: null, marginTrend: null, error: "Realized performance could not be loaded. Modeled strategy is still available." };
  }
}
