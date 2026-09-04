import type {
  CapitalCycleEconomics,
  CapitalCyclePortfolio,
} from "~/features/pricing/domain/capitalCycle";
import type { NumberFieldDescriptor } from "~/shared/components/ValidatedNumberField";
import type { InventoryStrategyProductLine } from "../types/inventoryStrategy";

/** Cycle inputs the reader can vary; overhead comes from the profit-per-day settings. */
export type CapitalCycleInputs = Pick<
  CapitalCycleEconomics,
  "costBasisShareOfMarket" | "costBasisDiscountPerUnit" | "turnaroundDays"
>;

export const DEFAULT_CAPITAL_CYCLE_INPUTS: CapitalCycleInputs = {
  costBasisShareOfMarket: 0.72,
  costBasisDiscountPerUnit: 0.3,
  turnaroundDays: 28,
};

export const CAPITAL_CYCLE_FIELDS: NumberFieldDescriptor<CapitalCycleInputs>[] =
  [
    {
      key: "costBasisShareOfMarket",
      label: "Cost basis share of market",
      step: 0.01,
      helperText: "Fraction of market value paid for inventory",
    },
    {
      key: "costBasisDiscountPerUnit",
      label: "Cost basis discount per unit",
      step: 0.01,
      helperText: "Dollars off the cost basis for every unit bought",
    },
    {
      key: "turnaroundDays",
      label: "Turnaround days",
      step: 1,
      helperText: "Days from a sale until the proceeds are relisted",
    },
  ];

export function cyclePortfolio(
  productLine: InventoryStrategyProductLine,
): CapitalCyclePortfolio {
  return {
    marketValue: productLine.estimatedMarketValue,
    unitCount: productLine.unitCount,
  };
}
