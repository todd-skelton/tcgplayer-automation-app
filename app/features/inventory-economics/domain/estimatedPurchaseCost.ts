import type { PurchaseCostInput } from "../types/inventoryEconomics";
import { dollarsToCents } from "./money";

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

/** How an estimate turns intake market into cost: a share of each unit's market, less a fixed amount per unit. */
export interface EstimatedCostRate {
  /** Share of the unit's intake market price, from 0 to 1. */
  marketRate: number;
  /** Cents taken off every unit's cost. */
  perUnitDeductionCents: number;
}

export const DEFAULT_ESTIMATED_COST_RATE: EstimatedCostRate = {
  marketRate: ESTIMATED_PURCHASE_COST_RULE.marketRate,
  perUnitDeductionCents: ESTIMATED_PURCHASE_COST_RULE.perUnitDeductionCents,
};

/** The largest amount a rate may take off each card, in cents. */
const MAXIMUM_PER_UNIT_DEDUCTION_CENTS = 10_000;

const isDefaultRate = (rate: EstimatedCostRate): boolean =>
  rate.marketRate === DEFAULT_ESTIMATED_COST_RATE.marketRate &&
  rate.perUnitDeductionCents === DEFAULT_ESTIMATED_COST_RATE.perUnitDeductionCents;

/**
 * A cost rate entered as a percent of market (0 to 100, at most two decimals)
 * and dollars less per card (at most $100.00).
 */
export function parseEstimatedCostRate(input: { marketPercent?: unknown; perCardDeduction?: unknown }): EstimatedCostRate {
  const percent = typeof input.marketPercent === "string" ? input.marketPercent.trim() : "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(percent) || Number(percent) > 100) {
    throw new Error("Percent of market must be between 0 and 100 with at most two decimal places.");
  }
  const perUnitDeductionCents = dollarsToCents(input.perCardDeduction, "Amount less per card");
  if (perUnitDeductionCents > MAXIMUM_PER_UNIT_DEDUCTION_CENTS) {
    throw new Error("Amount less per card must be at most $100.00.");
  }
  return { marketRate: Math.round(Number(percent) * 100) / 10_000, perUnitDeductionCents };
}

/** The rate's percent of market, as entered: up to two decimals. */
export function marketPercentOf(rate: EstimatedCostRate): string {
  return String(Math.round(rate.marketRate * 10_000) / 100);
}

/** Names a rate the way it is entered, for example "60% of market less $0.50 per card". */
export function describeEstimatedCostRate(rate: EstimatedCostRate): string {
  return `${marketPercentOf(rate)}% of market less $${(rate.perUnitDeductionCents / 100).toFixed(2)} per card`;
}

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

export function estimateUnitCostCents(
  marketValue: number,
  rate: EstimatedCostRate = DEFAULT_ESTIMATED_COST_RATE,
): number {
  if (!Number.isFinite(marketValue) || marketValue < 0) {
    throw new Error("Market value must be a nonnegative number.");
  }
  const marketCents = Math.round(marketValue * 100);
  const share = Math.round(marketCents * rate.marketRate);
  return share - rate.perUnitDeductionCents;
}

/** Names the rule and, when the batch overrides it, the rate, so a different rate records a new estimate. */
export function estimatedPurchaseCostRequestId(
  batchNumber: number,
  rate: EstimatedCostRate = DEFAULT_ESTIMATED_COST_RATE,
): string {
  const base = `estimated-purchase-cost:${ESTIMATED_PURCHASE_COST_RULE.version}:batch-${batchNumber}`;
  return isDefaultRate(rate)
    ? base
    : `${base}:market-${rate.marketRate}-less-${rate.perUnitDeductionCents}c`;
}

/**
 * A correction names the entry it corrects, so returning a batch to an earlier
 * rate records a new entry instead of reusing that rate's spent request ID.
 */
export function estimatedPurchaseCostCorrectionRequestId(requestId: string, correctsEntryId: string): string {
  return `${requestId}:corrects-${correctsEntryId}`;
}

/** Whether the current estimate entry was recorded for this request, directly or as a correction. */
export function isEstimateRecordedFor(currentRequestId: string, requestId: string): boolean {
  return currentRequestId === requestId || currentRequestId.startsWith(`${requestId}:corrects-`);
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

/** Builds one estimated purchase cost for every receipt lot of a batch, at the batch's cost rate. */
export function estimateBatchPurchaseCost(
  sellerKey: string,
  batchNumber: number,
  receipts: readonly EstimatedCostReceipt[],
  rate: EstimatedCostRate = DEFAULT_ESTIMATED_COST_RATE,
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
      amountCents: receipt.originalQuantity * estimateUnitCostCents(receipt.marketValue!, rate),
    };
  });
  const purchasedAt = earliestIntakeDate(receipts);
  return {
    status: "estimated",
    estimate: {
      batchNumber,
      unitCount: receipts.reduce((sum, receipt) => sum + receipt.originalQuantity, 0),
      purchaseCost: {
        requestId: estimatedPurchaseCostRequestId(batchNumber, rate),
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