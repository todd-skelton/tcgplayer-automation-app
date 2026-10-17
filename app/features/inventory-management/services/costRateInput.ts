import {
  parseEstimatedCostRate,
  type EstimatedCostRate,
} from "~/features/inventory-economics/domain/estimatedPurchaseCost";

/** A cost rate as typed: percent of market and dollars less per card. */
export interface CostRateInput {
  marketPercent: string;
  perCardDeduction: string;
}

const errorOf = (input: CostRateInput): string | undefined => {
  try {
    parseEstimatedCostRate(input);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** The parsed rate, or each field's own error. */
export function readCostRateInput(input: CostRateInput):
  | { valid: true; rate: EstimatedCostRate }
  | { valid: false; marketPercentError?: string; perCardDeductionError?: string } {
  const marketPercentError = errorOf({ ...input, perCardDeduction: "0" });
  const perCardDeductionError = errorOf({ ...input, marketPercent: "0" });
  return marketPercentError || perCardDeductionError
    ? { valid: false, marketPercentError, perCardDeductionError }
    : { valid: true, rate: parseEstimatedCostRate(input) };
}
