import {
  capitalCycle,
  type CapitalCycleEconomics,
  type CapitalCyclePortfolio,
} from "~/features/pricing/domain/capitalCycle";
import type { InventoryStrategyHurdleScenario } from "../types/inventoryStrategy";
import type {
  ForecastEvaluationReport,
  ForecastScore,
} from "~/features/pricing/domain/forecastEvaluation";

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

export type GradingStatus =
  | {
      graded: true;
      /** The best-scoring forecast. */
      label: string;
      grade: ForecastScore;
      baseRate: number;
    }
  | { graded: false; gradableAt: string | null };

/** The best held-out model score, or the frozen validation boundary. */
export function gradingStatus(
  report: ForecastEvaluationReport | null | undefined,
): GradingStatus {
  if (!report) return { graded: false, gradableAt: null };
  const [best] = report.models
    .map((model) => ({
      label: `${model.family} (${model.version})`,
      grade: model.validation,
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
  return { graded: false, gradableAt: report.validationCutoff };
}
