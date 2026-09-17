import type { PerformanceSummary } from "./realizedPerformance";
import type { InventoryStrategyHurdleScenario } from "../types/inventoryStrategy";

export interface Lever {
  title: string;
  detail: string;
}

export interface LeverInput {
  /** The hurdle the active policy prices at. */
  configuredHurdle: number;
  /** Highest modeled daily return on the ladder, and the configured one. */
  best: { scenario: InventoryStrategyHurdleScenario; dailyReturn: number } | undefined;
  configured: { scenario: InventoryStrategyHurdleScenario; dailyReturn: number } | undefined;
  /** Realized performance over the window being shown. */
  overall: PerformanceSummary | null;
  productLines: readonly PerformanceSummary[];
  /** Sale proceeds not yet republished, and how long the oldest has waited. */
  waitingCents: number;
  oldestWaitingDays: number | null;
  modeledUnits: number;
  totalUnits: number;
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const perDay = (fraction: number) => `${(fraction * 100).toFixed(2)}%/day`;
const percentPerDay = (percent: number) => `${percent.toFixed(2)}%/day`;
const signedMoney = (cents: number) => `${cents >= 0 ? "+" : "-"}${money.format(Math.abs(cents) / 100)}`;

/** Only lines with enough sales to say anything. */
const MINIMUM_LINE_UNITS = 10;

/**
 * Concrete changes ranked by how directly they move profit per day, each
 * stated with the numbers that justify it. Empty when nothing stands out.
 */
export function improvementLevers(input: LeverInput): Lever[] {
  const levers: Lever[] = [];
  const hurdle = input.configuredHurdle;

  if (input.best && !input.best.scenario.configured) {
    const { scenario, dailyReturn } = input.best;
    const change = input.configured?.scenario.estimatedTime && scenario.estimatedTime
      ? ` · ${signedMoney((scenario.physicalValue - input.configured.scenario.physicalValue) * 100)} listed value · ${(scenario.estimatedTime.medianDays - input.configured.scenario.estimatedTime.medianDays).toFixed(1)} days median wait`
      : "";
    levers.push({
      title: `${scenario.dailyReturnHurdle > hurdle ? "Raise" : "Lower"} the hurdle to ${perDay(scenario.dailyReturnHurdle)}`,
      detail: `Models ${perDay(dailyReturn)} on capital against ${input.configured ? perDay(input.configured.dailyReturn) : "the configured hurdle"} now${change}. Change it in the pricing configuration; the next pricing run applies it.`,
    });
  }

  const realized = input.overall?.dailyReturnPercent ?? null;
  if (realized !== null && input.overall && input.overall.includedUnits >= MINIMUM_LINE_UNITS) {
    const hurdlePercent = hurdle * 100;
    if (realized < hurdlePercent) {
      levers.push({
        title: "Sales are returning less than the hurdle assumes",
        detail: `Realized ${percentPerDay(realized)} on capital against a ${percentPerDay(hurdlePercent)} hurdle. Either prices are set for faster turns than buyers deliver, or capital sits in lots that take long to sell; check the slow product lines below.`,
      });
    } else {
      levers.push({
        title: "Sales are clearing the hurdle",
        detail: `Realized ${percentPerDay(realized)} on capital against a ${percentPerDay(hurdlePercent)} hurdle. Growth comes from more inventory at the same terms, or from a higher hurdle if the sweep shows it holds.`,
      });
    }
  }

  const laggards = input.productLines.filter((line) =>
    line.includedUnits >= MINIMUM_LINE_UNITS && line.dailyReturnPercent !== null && line.dailyReturnPercent < hurdle * 100);
  if (laggards.length > 0) {
    levers.push({
      title: `Below the hurdle: ${laggards.map((line) => line.productLine).join(", ")}`,
      detail: laggards.map((line) =>
        `${line.productLine} returned ${percentPerDay(line.dailyReturnPercent!)} on ${money.format(line.costCents / 100)} of cost, held ${line.averageDaysHeld?.toFixed(0) ?? "?"} days on average`).join("; ") +
        ". Buy less of these at the current terms, or reprice them to sell sooner.",
    });
  }
  const leaders = input.productLines.filter((line) =>
    line.includedUnits >= MINIMUM_LINE_UNITS && line.dailyReturnPercent !== null && line.dailyReturnPercent >= hurdle * 100 * 2);
  if (leaders.length > 0) {
    levers.push({
      title: `Well above the hurdle: ${leaders.map((line) => line.productLine).join(", ")}`,
      detail: leaders.map((line) =>
        `${line.productLine} returned ${percentPerDay(line.dailyReturnPercent!)} on ${money.format(line.costCents / 100)} of cost`).join("; ") +
        ". More capital here at the same purchase terms raises profit per day fastest.",
    });
  }

  if (input.waitingCents > 0) {
    levers.push({
      title: `${money.format(input.waitingCents / 100)} of proceeds not yet republished`,
      detail: `${input.oldestWaitingDays !== null ? `The oldest has waited ${input.oldestWaitingDays.toFixed(0)} days. ` : ""}Cash that is not on sale earns nothing; publishing replacement inventory sooner shortens every cycle.`,
    });
  }

  if (input.totalUnits > 0 && input.modeledUnits / input.totalUnits < 0.9) {
    levers.push({
      title: `${(input.totalUnits - input.modeledUnits).toLocaleString()} listed units have no forecast`,
      detail: "These SKUs had no usable sales history when priced, so they follow the market or listing reference instead of the policy. The hurdle sweep and verdict leave them out.",
    });
  }

  return levers;
}
