import {
  DEFAULT_ESTIMATED_COST_RATE,
  describeEstimatedCostRate,
  marketPercentOf,
} from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import { readCostRateInput, type CostRateInput } from "./costRateInput";
import type {
  EstimatedCostRateAtIntake,
  PurchaseCostAtIntake,
} from "./createPendingInventoryBatch";

export type NextBatchCostMethod = "estimate" | "cost_rate" | "purchase_total";

/** How the next queued batch is costed, as entered. */
export interface NextBatchCost {
  method: NextBatchCostMethod;
  costRate: CostRateInput;
  purchaseReference: string;
  purchaseTotal: string;
  purchaseDate: string;
  purchaseEstimated: boolean;
}

export const DEFAULT_NEXT_BATCH_COST: NextBatchCost = {
  method: "estimate",
  costRate: {
    marketPercent: marketPercentOf(DEFAULT_ESTIMATED_COST_RATE),
    perCardDeduction: (DEFAULT_ESTIMATED_COST_RATE.perUnitDeductionCents / 100).toFixed(2),
  },
  purchaseReference: "",
  purchaseTotal: "",
  purchaseDate: "",
  purchaseEstimated: false,
};

/** The cost choice in one line, for example "Default estimate: 75% of market less $0.30 per card". */
export function describeNextBatchCost(cost: NextBatchCost): string {
  if (cost.method === "purchase_total") {
    const reference = cost.purchaseReference.trim();
    const total = cost.purchaseTotal.trim().replace(/^\$\s*/, "");
    return reference && total
      ? `Purchase total: $${total} (${reference})`
      : "Purchase total: needs a reference and total";
  }
  if (cost.method === "cost_rate") {
    const read = readCostRateInput(cost.costRate);
    return read.valid ? `My rate: ${describeEstimatedCostRate(read.rate)}` : "My rate: needs a valid rate";
  }
  return `Default estimate: ${describeEstimatedCostRate(DEFAULT_ESTIMATED_COST_RATE)}`;
}

/** Why the cost choice cannot be queued yet, or null when it can. */
export function nextBatchCostProblem(cost: NextBatchCost): string | null {
  if (cost.method === "cost_rate" && !readCostRateInput(cost.costRate).valid)
    return "Enter a valid cost rate before queuing.";
  if (cost.method === "purchase_total" && (!cost.purchaseReference.trim() || !cost.purchaseTotal.trim()))
    return "Enter the purchase reference and total before queuing.";
  return null;
}

/** The cost a queued batch records, in the words of the confirmation message. */
export function describeQueuedCost(cost: NextBatchCost): string {
  if (cost.method === "purchase_total") return "the entered purchase total";
  const read = readCostRateInput(cost.costRate);
  return cost.method === "cost_rate" && read.valid
    ? `an estimate at ${describeEstimatedCostRate(read.rate)}`
    : `an estimate at the default ${describeEstimatedCostRate(DEFAULT_ESTIMATED_COST_RATE)}`;
}

/** The queue request's cost fields for the choice. */
export function nextBatchCostRequest(cost: NextBatchCost): {
  purchaseCost?: PurchaseCostAtIntake;
  estimatedCostRate?: EstimatedCostRateAtIntake;
} {
  if (cost.method === "purchase_total")
    return {
      purchaseCost: {
        purchaseReference: cost.purchaseReference.trim(),
        totalAmount: cost.purchaseTotal.trim(),
        provenance: cost.purchaseEstimated ? "estimated" : "actual",
        allocationRule: "quantity",
        ...(cost.purchaseDate ? { purchasedAt: cost.purchaseDate } : {}),
        currency: "USD",
      },
    };
  if (cost.method === "cost_rate")
    return {
      estimatedCostRate: {
        marketPercent: cost.costRate.marketPercent.trim(),
        perCardDeduction: cost.costRate.perCardDeduction.trim(),
      },
    };
  return {};
}

/**
 * The choice for the batch after this one. A cost rate describes the whole lot,
 * so it stays; a purchase total belongs to one handoff, so it clears.
 */
export function nextBatchCostAfterQueue(cost: NextBatchCost): NextBatchCost {
  return {
    ...cost,
    method: cost.method === "purchase_total" ? "estimate" : cost.method,
    purchaseReference: "",
    purchaseTotal: "",
    purchaseDate: "",
    purchaseEstimated: false,
  };
}
