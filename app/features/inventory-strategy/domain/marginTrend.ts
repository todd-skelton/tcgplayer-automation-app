import { summarizeSoldUnits, type PerformanceSummary, type SoldUnitLine } from "./realizedPerformance";
import type { PricingChange } from "./pricingChanges";

/** Weeks of selling the margin trend reaches back. */
export const MARGIN_TREND_WEEKS = 26;
/** Weeks blended into the trailing margin that smooths week-to-week noise. */
export const TRAILING_MARGIN_WEEKS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The three things an estimated-cost margin moves with. Estimated cost is a
 * fixed share of the market at intake, so margin rises and falls with what the
 * card sells for against the market, how far the market moved while it was
 * held, and how much of the sale fees, postage, and refunds leave.
 */
export interface MarginDrivers {
  /** Included units with a market price both at intake and when they sold. */
  marketPricedUnits: number;
  /** Sale price over the TCG market price when it sold: how pricing sells against the market. */
  priceToMarketPercent: number | null;
  /** Market price when it sold over the market price at intake: how the market moved while held. */
  marketChangePercent: number | null;
  /** Net proceeds over gross item sales: what is left after fees, postage, and refunds. */
  netToGrossPercent: number | null;
}

export interface MarginTrendWeek {
  /** Monday the week starts on (UTC), as YYYY-MM-DD. */
  weekStart: string;
  /** Whether the week was over as of the report; the current week is still filling. */
  ended: boolean;
  /** Days of the week with sales on record as of the report: 7 for a complete week. */
  coveredDays: number;
  summary: PerformanceSummary;
  /** Margin over the trailing four weeks ending with this one, weighted by net proceeds. */
  trailingMarginPercent: number | null;
  drivers: MarginDrivers;
}

export interface MarginTrend {
  weeks: MarginTrendWeek[];
  /** Days pricing changed within the trend, to read margin moves against. */
  pricingChanges: PricingChange[];
}

function mondayOf(time: number): number {
  const day = new Date(time);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS;
}

const ratioPercent = (numerator: number, denominator: number) => denominator > 0 ? (numerator / denominator) * 100 : null;

export function summarizeMarginDrivers(lines: readonly SoldUnitLine[]): MarginDrivers {
  const included = lines.filter((line) => line.netProceedsCents !== null && line.costCents !== null);
  const priced = included.filter((line) => (line.intakeMarketCents ?? 0) > 0 && (line.saleMarketCents ?? 0) > 0);
  const sum = (selected: readonly SoldUnitLine[], value: (line: SoldUnitLine) => number) =>
    selected.reduce((total, line) => total + value(line), 0);
  const pricedSaleMarket = sum(priced, (line) => line.saleMarketCents!);
  return {
    marketPricedUnits: sum(priced, (line) => line.quantity),
    priceToMarketPercent: ratioPercent(sum(priced, (line) => line.grossCents), pricedSaleMarket),
    marketChangePercent: ratioPercent(pricedSaleMarket, sum(priced, (line) => line.intakeMarketCents!)),
    netToGrossPercent: ratioPercent(sum(included, (line) => line.netProceedsCents!), sum(included, (line) => line.grossCents)),
  };
}

/**
 * Realized margin week by week, Monday to Sunday (UTC), from the first week
 * with a sale up to the current, possibly partial, week, with a trailing
 * four-week margin and the drivers behind each week's margin.
 */
export function summarizeMarginTrend(
  lines: readonly SoldUnitLine[],
  options: { now: Date; weeks?: number },
): MarginTrendWeek[] {
  if (!lines.length) return [];
  const now = options.now.getTime();
  const sales = lines.map((line) => ({ line, soldAt: new Date(line.soldAt).getTime() }));
  const firstSale = Math.min(...sales.map((sale) => sale.soldAt));
  const currentWeek = mondayOf(now);
  const firstWeek = Math.max(mondayOf(firstSale), currentWeek - ((options.weeks ?? MARGIN_TREND_WEEKS) - 1) * WEEK_MS);
  const soldBetween = (from: number, to: number) =>
    sales.filter((sale) => sale.soldAt >= from && sale.soldAt < to).map((sale) => sale.line);
  const weeks: MarginTrendWeek[] = [];
  for (let start = firstWeek; start <= currentWeek; start += WEEK_MS) {
    const end = start + WEEK_MS;
    const inWeek = soldBetween(start, end);
    const coveredDays = Math.max(1, (Math.min(end, now) - Math.max(start, firstSale)) / DAY_MS);
    weeks.push({
      weekStart: new Date(start).toISOString().slice(0, 10),
      ended: end <= now,
      coveredDays: Math.min(7, coveredDays),
      summary: summarizeSoldUnits("All product lines", inWeek, Math.min(7, coveredDays)),
      trailingMarginPercent: summarizeSoldUnits("All product lines", soldBetween(end - TRAILING_MARGIN_WEEKS * WEEK_MS, end), 1)
        .marginPercent,
      drivers: summarizeMarginDrivers(inWeek),
    });
  }
  return weeks;
}
