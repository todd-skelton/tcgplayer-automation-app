import {
  capitalCycle,
  type CapitalCycleEconomics,
  type CapitalCyclePortfolio,
} from "~/features/pricing/domain/capitalCycle";
import type {
  ForecastGradingReport,
  GradedForecast,
  InventoryStrategyHurdleScenario,
} from "../types/inventoryStrategy";

export interface HurdleReturn {
  scenario: InventoryStrategyHurdleScenario;
  /** Continuous daily growth of the cost basis over the cycle the hurdle implies. */
  dailyReturn: number;
}

/**
 * Each hurdle whose portfolio, sold for its value after its median wait,
 * grows the capital at risk, fastest compounding first.
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

/** The graded forecasts by label and report field. */
export const GRADED_FORECASTS = [
  ["Curve", "curve"],
  ["Buyer-choice", "buyerChoice"],
  ["Condition-rate", "conditionRate"],
] as const;

export type GradingStatus =
  | {
      graded: true;
      /** The best-scoring forecast. */
      label: string;
      grade: GradedForecast;
      baseRate: number;
    }
  | { graded: false; gradableAt: string | null };

/** Whether any forecast has a grade at this horizon, else when the first one will. */
export function gradingStatus(
  report: ForecastGradingReport | undefined,
): GradingStatus {
  if (!report) return { graded: false, gradableAt: null };
  const [best] = GRADED_FORECASTS.map(([label, key]) => ({
    label,
    grade: report[key],
  }))
    .filter(({ grade }) => grade.count > 0)
    .sort((left, right) => left.grade.brier - right.grade.brier);
  if (best) {
    return {
      graded: true,
      label: best.label,
      grade: best.grade,
      baseRate: best.grade.soldShare * (1 - best.grade.soldShare),
    };
  }
  const [gradableAt] = GRADED_FORECASTS.map(([, key]) => report[key].gradableAt)
    .filter((value): value is string => value !== null)
    .sort();
  return { graded: false, gradableAt: gradableAt ?? null };
}
