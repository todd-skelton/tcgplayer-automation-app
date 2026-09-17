import type { PurchaseCostInput } from "../types/inventoryEconomics";

/**
 * Estimated acquisition cost when no actual purchase price was recorded:
 * a share of the TCG market price observed at intake, less a fixed amount
 * per unit. A unit worth less than the deduction carries a negative cost:
 * the seller effectively paid to have it taken. The rule version is part of
 * every request ID so a rule change re-estimates instead of silently repeating.
 */
export const ESTIMATED_PURCHASE_COST_RULE = {
  version: "market-rate-v2",
  marketRate: 0.75,
  perUnitDeductionCents: 30,
  currency: "USD",
} as const;

export interface EstimatedCostReceipt {
  receiptId: number;
  originalQuantity: number;
  /** Unit market value observed at intake, or null when no quote was captured. */
  marketValue: number | null;
  intakeAt: string | null;
}

export interface EstimatedBatchCost {
  batchNumber: number;
  purchaseCost: PurchaseCostInput;
  unitCount: number;
}

export type EstimatedBatchCostResult =
  | { status: "estimated"; estimate: EstimatedBatchCost }
  | { status: "market_unavailable"; batchNumber: number; receiptIds: number[] };

export function estimateUnitCostCents(marketValue: number): number {
  if (!Number.isFinite(marketValue) || marketValue < 0) {
    throw new Error("Market value must be a nonnegative number.");
  }
  const marketCents = Math.round(marketValue * 100);
  const share = Math.round(marketCents * ESTIMATED_PURCHASE_COST_RULE.marketRate);
  return share - ESTIMATED_PURCHASE_COST_RULE.perUnitDeductionCents;
}

export function estimatedPurchaseCostRequestId(batchNumber: number): string {
  return `estimated-purchase-cost:${ESTIMATED_PURCHASE_COST_RULE.version}:batch-${batchNumber}`;
}

export function estimatedPurchaseReference(batchNumber: number): string {
  return `estimated:batch-${batchNumber}`;
}

function earliestIntakeDate(receipts: readonly EstimatedCostReceipt[]): string | undefined {
  const times = receipts
    .map((receipt) => (receipt.intakeAt ? Date.parse(receipt.intakeAt) : Number.NaN))
    .filter((time) => Number.isFinite(time));
  if (!times.length) return undefined;
  return new Date(Math.min(...times)).toISOString().slice(0, 10);
}

/** Builds one estimated purchase cost for every receipt lot of a batch. */
export function estimateBatchPurchaseCost(
  sellerKey: string,
  batchNumber: number,
  receipts: readonly EstimatedCostReceipt[],
): EstimatedBatchCostResult {
  if (!Number.isInteger(batchNumber) || batchNumber <= 0) throw new Error("Batch number must be a positive integer.");
  if (!receipts.length) throw new Error("An estimated purchase cost requires at least one receipt lot.");
  const missingMarket = receipts.filter((receipt) => receipt.marketValue === null).map((receipt) => receipt.receiptId);
  if (missingMarket.length) return { status: "market_unavailable", batchNumber, receiptIds: missingMarket };
  const explicitAllocations = receipts.map((receipt) => {
    if (!Number.isInteger(receipt.originalQuantity) || receipt.originalQuantity <= 0) {
      throw new Error(`Receipt ${receipt.receiptId} quantity must be a positive integer.`);
    }
    return {
      receiptId: receipt.receiptId,
      amountCents: receipt.originalQuantity * estimateUnitCostCents(receipt.marketValue!),
    };
  });
  const purchasedAt = earliestIntakeDate(receipts);
  return {
    status: "estimated",
    estimate: {
      batchNumber,
      unitCount: receipts.reduce((sum, receipt) => sum + receipt.originalQuantity, 0),
      purchaseCost: {
        requestId: estimatedPurchaseCostRequestId(batchNumber),
        sellerKey,
        purchaseReference: estimatedPurchaseReference(batchNumber),
        currency: ESTIMATED_PURCHASE_COST_RULE.currency,
        totalAmountCents: explicitAllocations.reduce((sum, allocation) => sum + allocation.amountCents, 0),
        provenance: "estimated",
        source: "intake",
        allocationRule: "explicit",
        batchNumbers: [batchNumber],
        ...(purchasedAt ? { purchasedAt } : {}),
        explicitAllocations,
      },
    },
  };
}