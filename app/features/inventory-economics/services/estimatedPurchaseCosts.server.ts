import { inventoryEconomicsRepository } from "~/core/db";
import type { Queryable } from "~/core/db/database.server";
import {
  ESTIMATED_PURCHASE_COST_RULE,
  estimateBatchPurchaseCost,
} from "../domain/estimatedPurchaseCost";

export interface EstimatedPurchaseCostDependencies {
  findUncostedBatchReceipts: typeof inventoryEconomicsRepository.findUncostedBatchReceipts;
  recordPurchaseCost: typeof inventoryEconomicsRepository.recordPurchaseCost;
}

const defaultDependencies: EstimatedPurchaseCostDependencies = {
  findUncostedBatchReceipts: inventoryEconomicsRepository.findUncostedBatchReceipts,
  recordPurchaseCost: inventoryEconomicsRepository.recordPurchaseCost,
};

export interface EstimatedPurchaseCostRun {
  rule: typeof ESTIMATED_PURCHASE_COST_RULE;
  recorded: Array<{ batchNumber: number; entryId: string; totalAmountCents: number; unitCount: number }>;
  repeated: number[];
  marketUnavailable: Array<{ batchNumber: number; receiptIds: number[] }>;
}

/**
 * Records the estimated purchase cost for every batch of the seller whose lots
 * have no purchase cost. Safe to repeat: an existing estimate is reported as
 * repeated and an entered cost is never replaced.
 */
export async function recordEstimatedPurchaseCosts(
  sellerKey: string,
  options: { batchNumbers?: number[]; limit?: number } = {},
  dependencies: EstimatedPurchaseCostDependencies = defaultDependencies,
  executor?: Queryable,
): Promise<EstimatedPurchaseCostRun> {
  const run: EstimatedPurchaseCostRun = {
    rule: ESTIMATED_PURCHASE_COST_RULE, recorded: [], repeated: [], marketUnavailable: [],
  };
  const batches = await dependencies.findUncostedBatchReceipts(sellerKey, options, executor);
  for (const batch of batches) {
    const result = estimateBatchPurchaseCost(sellerKey, batch.batchNumber, batch.receipts);
    if (result.status === "market_unavailable") {
      run.marketUnavailable.push({ batchNumber: result.batchNumber, receiptIds: result.receiptIds });
      continue;
    }
    const saved = await dependencies.recordPurchaseCost(result.estimate.purchaseCost, executor);
    if (saved.repeated) run.repeated.push(batch.batchNumber);
    else run.recorded.push({
      batchNumber: batch.batchNumber, entryId: saved.entryId,
      totalAmountCents: result.estimate.purchaseCost.totalAmountCents, unitCount: result.estimate.unitCount,
    });
  }
  return run;
}