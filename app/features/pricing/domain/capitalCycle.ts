import {
  horizonValue,
  logSpacedHorizons,
  type HorizonValueCurve,
} from "./horizonValueCurve";
import { maximizeOverCandidates } from "./maximize";

/** Seller economics that turn sale value at a horizon into return on capital. */
export interface CapitalCycleEconomics {
  /** Cost basis as a share of market value. */
  costBasisShareOfMarket: number;
  /**
   * Dollars off the cost basis for every unit bought, as when a lot is priced
   * at a share of market less an allowance per card. Bulk the seller was paid
   * to take can make the cost basis negative.
   */
  costBasisDiscountPerUnit: number;
  /** Overhead as a fraction of sale value. */
  relativeOverhead: number;
  /** Overhead in dollars per unit sold. */
  staticOverheadPerUnit: number;
  /** Days from a sale until the proceeds are relisted as new inventory. */
  turnaroundDays: number;
}

export interface CapitalCyclePortfolio {
  marketValue: number;
  unitCount: number;
}

export interface CapitalCycle {
  horizonDays: number;
  netProceeds: number;
  profit: number;
  cycleDays: number;
  profitPerDay: number;
  /**
   * Continuous rate per cycle day at which the cycle grows its capital;
   * undefined when no capital is at risk, nothing comes back, or the cycle
   * takes no time.
   */
  dailyReturn: number | undefined;
}

const BEST_CYCLE_GRID_COUNT = 128;

/**
 * One capital cycle at a target horizon: sell at the modeled value, pay
 * overhead, recover the cost basis, and wait out the turnaround before the
 * money is working again.
 */
export function capitalCycleAtHorizon(
  curve: HorizonValueCurve,
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
  horizonDays: number,
): CapitalCycle {
  const netProceeds =
    horizonValue(curve, horizonDays) * (1 - economics.relativeOverhead) -
    economics.staticOverheadPerUnit * portfolio.unitCount;
  const cost =
    economics.costBasisShareOfMarket * portfolio.marketValue -
    economics.costBasisDiscountPerUnit * portfolio.unitCount;
  const profit = netProceeds - cost;
  const cycleDays = horizonDays + economics.turnaroundDays;
  return {
    horizonDays,
    netProceeds,
    profit,
    cycleDays,
    profitPerDay: cycleDays > 0 ? profit / cycleDays : 0,
    dailyReturn:
      cycleDays > 0 && cost > 0 && netProceeds > 0
        ? Math.log(netProceeds / cost) / cycleDays
        : undefined,
  };
}

/**
 * The cycle with the most profit per day within the observed range, or
 * undefined when no horizon in the range turns a profit.
 */
export function bestCapitalCycle(
  curve: HorizonValueCurve,
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
  range: { minimumHorizonDays: number; maximumHorizonDays: number },
): CapitalCycle | undefined {
  const best = maximizeOverCandidates(
    logSpacedHorizons(
      range.minimumHorizonDays,
      range.maximumHorizonDays,
      BEST_CYCLE_GRID_COUNT,
    ),
    (horizonDays) =>
      capitalCycleAtHorizon(curve, portfolio, economics, horizonDays)
        .profitPerDay,
  );
  return best && best.value > 0
    ? capitalCycleAtHorizon(curve, portfolio, economics, best.argument)
    : undefined;
}
