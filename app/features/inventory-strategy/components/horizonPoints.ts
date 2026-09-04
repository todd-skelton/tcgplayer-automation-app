import {
  capitalCycleAtHorizon,
  type CapitalCycleEconomics,
  type CapitalCyclePortfolio,
} from "~/features/pricing/domain/capitalCycle";
import {
  horizonGainElasticity,
  horizonMarginalValuePerDay,
  horizonValue,
  logSpacedHorizons,
  type HorizonValueCurve,
} from "~/features/pricing/domain/horizonValueCurve";

/** Everything the page shows about one horizon on a fitted curve. */
export interface HorizonPoint {
  horizonDays: number;
  value: number;
  marginalValuePerDay: number;
  elasticity: number;
  profitPerDay: number;
  netProceeds: number;
  profit: number;
}

export function horizonPoint(
  curve: HorizonValueCurve,
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
  horizonDays: number,
): HorizonPoint {
  const cycle = capitalCycleAtHorizon(curve, portfolio, economics, horizonDays);
  return {
    horizonDays,
    value: horizonValue(curve, horizonDays),
    marginalValuePerDay: horizonMarginalValuePerDay(curve, horizonDays),
    elasticity: horizonGainElasticity(curve, horizonDays),
    profitPerDay: cycle.profitPerDay,
    netProceeds: cycle.netProceeds,
    profit: cycle.profit,
  };
}

/** Points spaced evenly in log horizon across the observed range. */
export function sampleHorizonPoints(
  curve: HorizonValueCurve,
  range: { minimumHorizonDays: number; maximumHorizonDays: number },
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
  count: number,
): HorizonPoint[] {
  return logSpacedHorizons(
    range.minimumHorizonDays,
    range.maximumHorizonDays,
    count,
  ).map((horizonDays) =>
    horizonPoint(curve, portfolio, economics, horizonDays),
  );
}
