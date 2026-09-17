/** One sold unit lot: what it brought in, what it cost, and how long it was held. */
export interface SoldUnitLine {
  orderNumber: string;
  soldAt: string;
  productLine: string;
  quantity: number;
  /** Net proceeds after fees, postage, and refunds; null when the order's economics are unknown. */
  netProceedsCents: number | null;
  /** Estimated or actual acquisition cost; null when the lot is uncosted. */
  costCents: number | null;
  /** Days between receiving the lot and the sale. */
  daysHeld: number;
}

export interface PerformanceSummary {
  productLine: string;
  unitsSold: number;
  /** Units whose proceeds and cost are both known; every money figure covers only these. */
  includedUnits: number;
  proceedsCents: number;
  costCents: number;
  profitCents: number;
  /** Profit over net proceeds. */
  marginPercent: number | null;
  /** Profit over cost. */
  markupPercent: number | null;
  /** Profit spread over the days the window actually covers. */
  profitPerDayCents: number | null;
  /** Profit over cost-days: the observed counterpart of the daily return hurdle. */
  dailyReturnPercent: number | null;
  averageDaysHeld: number | null;
}

export interface PerformanceWindow {
  windowDays: number;
  /** Days the window actually covers, bounded by the first sale on record. */
  coveredDays: number;
  overall: PerformanceSummary;
  productLines: PerformanceSummary[];
}

export interface RealizedPerformance {
  asOf: string;
  firstSaleAt: string | null;
  windows: PerformanceWindow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function summarize(productLine: string, lines: SoldUnitLine[], coveredDays: number): PerformanceSummary {
  const included = lines.filter((line) => line.netProceedsCents !== null && line.costCents !== null);
  const unitsSold = lines.reduce((sum, line) => sum + line.quantity, 0);
  const includedUnits = included.reduce((sum, line) => sum + line.quantity, 0);
  const proceedsCents = included.reduce((sum, line) => sum + line.netProceedsCents!, 0);
  const costCents = included.reduce((sum, line) => sum + line.costCents!, 0);
  const profitCents = proceedsCents - costCents;
  // Capital at risk is never negative: a lot the seller was paid to take ties up nothing.
  const costDays = included.reduce((sum, line) => sum + Math.max(line.costCents!, 0) * line.daysHeld, 0);
  const heldDays = lines.reduce((sum, line) => sum + line.daysHeld * line.quantity, 0);
  return {
    productLine,
    unitsSold,
    includedUnits,
    proceedsCents,
    costCents,
    profitCents,
    marginPercent: proceedsCents > 0 ? (profitCents / proceedsCents) * 100 : null,
    markupPercent: costCents > 0 ? (profitCents / costCents) * 100 : null,
    profitPerDayCents: includedUnits > 0 && coveredDays > 0 ? profitCents / coveredDays : null,
    dailyReturnPercent: costDays > 0 ? (profitCents / costDays) * 100 : null,
    averageDaysHeld: unitsSold > 0 ? heldDays / unitsSold : null,
  };
}

/**
 * Realized margin, profit per day, and return on capital over trailing
 * windows, overall and by product line, from sold units with known
 * proceeds and cost.
 */
export function summarizeRealizedPerformance(
  lines: readonly SoldUnitLine[],
  options: { now: Date; windowDays: readonly number[] },
): RealizedPerformance {
  const now = options.now.getTime();
  const firstSale = lines.reduce<number | null>((earliest, line) => {
    const soldAt = new Date(line.soldAt).getTime();
    return earliest === null || soldAt < earliest ? soldAt : earliest;
  }, null);
  const windows = options.windowDays.map((windowDays) => {
    const from = now - windowDays * DAY_MS;
    const inWindow = lines.filter((line) => new Date(line.soldAt).getTime() >= from);
    const coveredDays = firstSale === null ? 0
      : Math.max(1, Math.min(windowDays, (now - Math.max(from, firstSale)) / DAY_MS));
    const byLine = new Map<string, SoldUnitLine[]>();
    for (const line of inWindow) {
      byLine.set(line.productLine, [...(byLine.get(line.productLine) ?? []), line]);
    }
    return {
      windowDays,
      coveredDays,
      overall: summarize("All product lines", inWindow, coveredDays),
      productLines: [...byLine.entries()]
        .map(([productLine, productLineLines]) => summarize(productLine, productLineLines, coveredDays))
        .sort((left, right) => right.proceedsCents - left.proceedsCents || left.productLine.localeCompare(right.productLine)),
    };
  });
  return {
    asOf: options.now.toISOString(),
    firstSaleAt: firstSale === null ? null : new Date(firstSale).toISOString(),
    windows,
  };
}
