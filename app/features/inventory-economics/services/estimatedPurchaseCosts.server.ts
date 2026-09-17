import { inventoryEconomicsRepository } from "~/core/db";
import type { Queryable } from "~/core/db/database.server";
import {
  ESTIMATED_PURCHASE_COST_RULE,
  estimateBatchPurchaseCost,
} from "../domain/estimatedPurchaseCost";

export interface EstimatedPurchaseCostDependencies {
  findEstimableBatchReceipts: typeof inventoryEconomicsRepository.findEstimableBatchReceipts;
  recordPurchaseCost: typeof inventoryEconomicsRepository.recordPurchaseCost;
}

const defaultDependencies: EstimatedPurchaseCostDependencies = {
  findEstimableBatchReceipts: inventoryEconomicsRepository.findEstimableBatchReceipts,
  recordPurchaseCost: inventoryEconomicsRepository.recordPurchaseCost,
};

export interface EstimatedPurchaseCostRun {
  rule: typeof ESTIMATED_PURCHASE_COST_RULE;
  recorded: Array<{ batchNumber: number; entryId: string; totalAmountCents: number; unitCount: number; correctsEntryId?: string }>;
  /** Batches already estimated under the current rule. */
  repeated: number[];
  /** Batches estimated under an earlier rule whose amounts the current rule leaves unchanged. */
  unchanged: number[];
  marketUnavailable: Array<{ batchNumber: number; receiptIds: number[] }>;
}

/**
 * Records the estimated purchase cost for every batch of the seller whose lots
 * have no purchase cost, and corrects estimates recorded under an earlier rule
 * when the current rule changes their amounts. Safe to repeat, and an entered
 * cost is never replaced.
 */
export async function recordEstimatedPurchaseCosts(
  sellerKey: string,
  options: { batchNumbers?: number[]; limit?: number } = {},
  dependencies: EstimatedPurchaseCostDependencies = defaultDependencies,
  executor?: Queryable,
): Promise<EstimatedPurchaseCostRun> {
  const run: EstimatedPurchaseCostRun = {
    rule: ESTIMATED_PURCHASE_COST_RULE, recorded: [], repeated: [], unchanged: [], marketUnavailable: [],
  };
  const batches = await dependencies.findEstimableBatchReceipts(sellerKey, options, executor);
  for (const batch of batches) {
    const result = estimateBatchPurchaseCost(sellerKey, batch.batchNumber, batch.receipts);
    if (result.status === "market_unavailable") {
      run.marketUnavailable.push({ batchNumber: result.batchNumber, receiptIds: result.receiptIds });
      continue;
    }
    let purchaseCost = result.estimate.purchaseCost;
    const current = batch.currentEstimate;
    if (current) {
      if (current.requestId === purchaseCost.requestId) { run.repeated.push(batch.batchNumber); continue; }
      const unchanged = purchaseCost.explicitAllocations!.every((allocation) =>
        batch.receipts.find((receipt) => receipt.receiptId === allocation.receiptId)?.allocatedAmountCents === allocation.amountCents);
      if (unchanged) { run.unchanged.push(batch.batchNumber); continue; }
      purchaseCost = { ...purchaseCost, correctsEntryId: current.entryId,
        correctionReason: `Re-estimated under rule ${ESTIMATED_PURCHASE_COST_RULE.version}` };
    }
    const saved = await dependencies.recordPurchaseCost(purchaseCost, executor);
    if (saved.repeated) run.repeated.push(batch.batchNumber);
    else run.recorded.push({
      batchNumber: batch.batchNumber, entryId: saved.entryId,
      totalAmountCents: purchaseCost.totalAmountCents, unitCount: result.estimate.unitCount,
      ...(current ? { correctsEntryId: current.entryId } : {}),
    });
  }
  return run;
}