import {
  capitalCycle,
  type CapitalCycleEconomics,
  type CapitalCyclePortfolio,
} from "~/features/pricing/domain/capitalCycle";
import type { InventoryStrategyHurdleScenario } from "../types/inventoryStrategy";
import type { ForecastEvaluationReport } from "~/features/pricing/domain/forecastEvaluation";

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

export interface ForecastGradingOverview {
  state: "unavailable" | "pending" | "scored";
  label: string;
}

/** A neutral summary; model comparisons remain on their exact paired cohorts. */
export function forecastGradingOverview(
  report: ForecastEvaluationReport | null | undefined,
): ForecastGradingOverview {
  if (!report) {
    return { state: "unavailable", label: "Forecast validation has insufficient evidence" };
  }
  const scoredVersions = report.models.filter((model) => model.validation.count > 0).length;
  if (scoredVersions === 0) {
    return {
      state: "pending",
      label: `Forecast validation reserved through ${new Date(report.validationCutoff).toLocaleDateString()}`,
    };
  }
  const comparisons = report.pairedComparisons ?? [];
  const minimum = report.policy?.minimumPairedValidationCount ?? 20;
  const qualified = comparisons.filter((comparison) =>
    comparison.validationCount >= minimum &&
    comparison.leftBrier !== null && comparison.rightBrier !== null).length;
  const versions = `${scoredVersions} forecast ${scoredVersions === 1 ? "version" : "versions"} scored`;
  return {
    state: "scored",
    label: comparisons.length === 0
      ? `${versions} · no cross-model pair is available`
      : `${versions} · ${qualified} of ${comparisons.length} pair ${comparisons.length === 1 ? "comparison meets" : "comparisons meet"} the ${minimum}-observation minimum`,
  };
}
