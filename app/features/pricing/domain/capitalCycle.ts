import {
  horizonValue,
  logSpacedHorizons,
  type HorizonValueCurve,
} from "./horizonValueCurve";

/** Seller economics that turn sale value at a horizon into return on capital. */
export interface CapitalCycleEconomics {
  /** Cost basis as a fraction of market value. */
  costRatio: number;
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
  netProceeds: number;
  profit: number;
  cycleDays: number;
  profitPerDay: number;
}

const OPTIMUM_GRID_COUNT = 128;
const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;
const REFINEMENT_ITERATIONS = 24;

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
  const profit = netProceeds - economics.costRatio * portfolio.marketValue;
  const cycleDays = horizonDays + economics.turnaroundDays;
  return {
    netProceeds,
    profit,
    cycleDays,
    profitPerDay: cycleDays > 0 ? profit / cycleDays : 0,
  };
}

/**
 * Horizon that maximizes profit per day of cycle within the observed range,
 * or undefined when no horizon in the range turns a profit. Profit per day
 * can carry more than one local peak, so a log-spaced grid finds the best
 * region first and a golden-section pass sharpens it.
 */
export function bestCycleHorizonDays(
  curve: HorizonValueCurve,
  portfolio: CapitalCyclePortfolio,
  economics: CapitalCycleEconomics,
  range: { minimumHorizonDays: number; maximumHorizonDays: number },
): number | undefined {
  const profitPerDay = (horizonDays: number) =>
    capitalCycleAtHorizon(curve, portfolio, economics, horizonDays)
      .profitPerDay;
  const grid = logSpacedHorizons(
    range.minimumHorizonDays,
    range.maximumHorizonDays,
    OPTIMUM_GRID_COUNT,
  );
  const profits = grid.map(profitPerDay);
  const bestIndex = profits.indexOf(Math.max(...profits));
  if (!(profits[bestIndex] > 0)) return undefined;

  let low = Math.log(grid[Math.max(0, bestIndex - 1)]);
  let high = Math.log(grid[Math.min(grid.length - 1, bestIndex + 1)]);
  for (let iteration = 0; iteration < REFINEMENT_ITERATIONS; iteration += 1) {
    const lower = high - GOLDEN_RATIO * (high - low);
    const upper = low + GOLDEN_RATIO * (high - low);
    if (profitPerDay(Math.exp(lower)) < profitPerDay(Math.exp(upper))) {
      low = lower;
    } else {
      high = upper;
    }
  }
  return Math.exp((low + high) / 2);
}
