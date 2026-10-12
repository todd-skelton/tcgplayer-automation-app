import { inventoryEconomicsRepository } from "~/core/db";
import { withTransaction, type Queryable } from "~/core/db/database.server";
import {
  DEFAULT_ESTIMATED_COST_RATE,
  ESTIMATED_PURCHASE_COST_RULE,
  estimateBatchPurchaseCost,
  estimatedPurchaseCostCorrectionRequestId,
  isEstimateRecordedFor,
  describeEstimatedCostRate,
  type EstimatedCostRate,
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
 * have no purchase cost, at the batch's own cost rate when it overrides the
 * default, and corrects estimates recorded under an earlier rule or rate when
 * the current one changes their amounts. Safe to repeat, and an entered cost is
 * never replaced.
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
    const rate = batch.costRate ?? DEFAULT_ESTIMATED_COST_RATE;
    const result = estimateBatchPurchaseCost(sellerKey, batch.batchNumber, batch.receipts, rate);
    if (result.status === "market_unavailable") {
      run.marketUnavailable.push({ batchNumber: result.batchNumber, receiptIds: result.receiptIds });
      continue;
    }
    let purchaseCost = result.estimate.purchaseCost;
    const current = batch.currentEstimate;
    if (current) {
      if (isEstimateRecordedFor(current.requestId, purchaseCost.requestId)) { run.repeated.push(batch.batchNumber); continue; }
      const unchanged = purchaseCost.explicitAllocations!.every((allocation) =>
        batch.receipts.find((receipt) => receipt.receiptId === allocation.receiptId)?.allocatedAmountCents === allocation.amountCents);
      if (unchanged) { run.unchanged.push(batch.batchNumber); continue; }
      purchaseCost = { ...purchaseCost, correctsEntryId: current.entryId,
        requestId: estimatedPurchaseCostCorrectionRequestId(purchaseCost.requestId, current.entryId),
        correctionReason: batch.costRate
          ? `Re-estimated under rule ${ESTIMATED_PURCHASE_COST_RULE.version} at ${describeEstimatedCostRate(batch.costRate)}`
          : `Re-estimated under rule ${ESTIMATED_PURCHASE_COST_RULE.version}` };
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

/** The batch has no estimate whose rate could change: an entered purchase cost owns it, or it has no received cards for the seller. */
export class BatchCostRateUnavailableError extends Error {}

export interface BatchCostRateChangeDependencies extends EstimatedPurchaseCostDependencies {
  transaction: <T>(work: (executor: Queryable) => Promise<T>) => Promise<T>;
  saveBatchEstimatedCostRate: typeof inventoryEconomicsRepository.saveBatchEstimatedCostRate;
}

const rateChangeDependencies: BatchCostRateChangeDependencies = {
  ...defaultDependencies,
  transaction: withTransaction,
  saveBatchEstimatedCostRate: inventoryEconomicsRepository.saveBatchEstimatedCostRate,
};

/**
 * Changes the rate a batch's purchase cost is estimated at and re-estimates
 * the batch, recording a correction when its amounts change. An entered
 * purchase cost is never replaced.
 */
export async function changeBatchEstimatedCostRate(
  sellerKey: string,
  batchNumber: number,
  rate: EstimatedCostRate,
  dependencies: BatchCostRateChangeDependencies = rateChangeDependencies,
): Promise<EstimatedPurchaseCostRun> {
  return dependencies.transaction(async (executor) => {
    const [batch] = await dependencies.findEstimableBatchReceipts(sellerKey, { batchNumbers: [batchNumber] }, executor);
    if (!batch) {
      throw new BatchCostRateUnavailableError(
        `Batch ${batchNumber} has an entered purchase cost or no received cards for seller ${sellerKey}, so it has no estimate to change.`,
      );
    }
    await dependencies.saveBatchEstimatedCostRate(batchNumber, rate, executor);
    return recordEstimatedPurchaseCosts(sellerKey, { batchNumbers: [batchNumber] }, dependencies, executor);
  });
}

export interface MissingEstimatedPurchaseCostDependencies {
  findUncostedBatchNumbers: typeof inventoryEconomicsRepository.findUncostedBatchNumbers;
  recordEstimatedPurchaseCosts: typeof recordEstimatedPurchaseCosts;
}

const missingCostDependencies: MissingEstimatedPurchaseCostDependencies = {
  findUncostedBatchNumbers: inventoryEconomicsRepository.findUncostedBatchNumbers,
  recordEstimatedPurchaseCosts,
};

/**
 * Estimates every batch that still has an uncosted lot. A batch is estimated
 * when it is created, but a card without a market price at intake leaves it
 * uncosted until pricing records the card's weekly market or publication
 * records its listed price; repeating this picks it up once either exists.
 */
export async function recordMissingEstimatedPurchaseCosts(
  sellerKey: string,
  dependencies: MissingEstimatedPurchaseCostDependencies = missingCostDependencies,
): Promise<EstimatedPurchaseCostRun | null> {
  const batchNumbers = await dependencies.findUncostedBatchNumbers(sellerKey);
  return batchNumbers.length ? dependencies.recordEstimatedPurchaseCosts(sellerKey, { batchNumbers }) : null;
}
