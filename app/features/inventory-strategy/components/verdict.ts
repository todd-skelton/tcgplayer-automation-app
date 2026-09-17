import {
  capitalCycle,
  type CapitalCycleEconomics,
  type CapitalCyclePortfolio,
} from "~/features/pricing/domain/capitalCycle";
import { ESTIMATED_PURCHASE_COST_RULE } from "~/features/inventory-economics/domain/estimatedPurchaseCost";
import type {
  InventoryStrategyHurdleScenario,
  InventoryStrategyProductLine,
} from "../types/inventoryStrategy";

/** The cost basis the strategy assumes: the same rule that estimates purchase costs. */
export const STRATEGY_COST_BASIS: Pick<
  CapitalCycleEconomics,
  "costBasisShareOfMarket" | "costBasisDiscountPerUnit"
> = {
  costBasisShareOfMarket: ESTIMATED_PURCHASE_COST_RULE.marketRate,
  costBasisDiscountPerUnit: ESTIMATED_PURCHASE_COST_RULE.perUnitDeductionCents / 100,
};

export function cyclePortfolio(
  productLine: InventoryStrategyProductLine,
): CapitalCyclePortfolio {
  return {
    marketValue: productLine.estimatedMarketValue,
    unitCount: productLine.unitCount,
  };
}

export interface HurdleReturn {
  scenario: InventoryStrategyHurdleScenario;
  /** Continuous daily growth of the cost basis over the cycle the hurdle implies. */
  dailyReturn: number;
}

/**
 * Each hurdle whose portfolio, sold for its value after its median wait,
 * has the highest simplified modeled daily return on capital at risk.
 */
export function hurdleReturns(
  sweep: readonly InventoryStrategyHurdleScenario[],
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
): HurdleReturn[] {
  return sweep
    .flatMap((scenario) => {
      if (!scenario.estimatedTime) return [];
      const { dailyReturn } = capitalCycle(
        scenario.physicalValue,
        scenario.estimatedTime.medianDays,
        portfolio,
        economics,
      );
      return dailyReturn === undefined || dailyReturn <= 0
        ? []
        : [{ scenario, dailyReturn }];
    })
    .sort((left, right) => right.dailyReturn - left.dailyReturn);
}
