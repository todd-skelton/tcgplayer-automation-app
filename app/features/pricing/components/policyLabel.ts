import type {
  ActivePricingPolicy,
  PricingDecision,
} from "~/core/types/pricingPolicy";

/** "7.5 days", "120 days", or "N/A" without a value. */
export function formatDays(days: number | undefined): string {
  if (days === undefined || !Number.isFinite(days)) return "N/A";
  const rounded = days >= 100 ? Math.round(days) : Math.round(days * 10) / 10;
  return `${rounded.toLocaleString()} days`;
}

export function formatHurdle(dailyReturnHurdle: number): string {
  return `${(dailyReturnHurdle * 100).toFixed(2)}%/day`;
}

export function formatPercentile(percentile: number): string {
  const rounded = Math.round(percentile);
  const remainder = rounded % 100;
  if (remainder >= 11 && remainder <= 13) return `${rounded}th`;
  if (rounded % 10 === 1) return `${rounded}st`;
  if (rounded % 10 === 2) return `${rounded}nd`;
  if (rounded % 10 === 3) return `${rounded}rd`;
  return `${rounded}th`;
}

/** The active policy as a sentence fragment. */
export function describePricingPolicy(policy: ActivePricingPolicy): string {
  switch (policy.method) {
    case "percentile":
      return "Configured percentile per product line";
    case "target-horizon":
      return `Target horizon of ${formatDays(policy.horizonDays)}`;
    case "profit-per-day":
      return `Profit per day at a ${formatHurdle(policy.dailyReturnHurdle)} hurdle`;
  }
}

/** The rule one decision followed, e.g. "65th percentile" or "0.50%/day hurdle". */
export function describeDecisionRule(decision: PricingDecision): string {
  switch (decision.method) {
    case "percentile":
      return decision.configuredPercentile === undefined
        ? "Percentile"
        : `${formatPercentile(decision.configuredPercentile)} percentile`;
    case "target-horizon":
      return `${formatDays(decision.targetHorizonDays)} target`;
    case "profit-per-day":
      return `${formatHurdle(decision.dailyReturnHurdle ?? 0)} hurdle`;
  }
}

/** Where a decision's price came from when it was not modeled from the curve. */
export function describeDecisionBasis(decision: PricingDecision): string {
  return decision.basis.replaceAll("-", " ");
}

/** The policy's name as a column heading. */
export function policyMethodLabel(method: PricingDecision["method"]): string {
  switch (method) {
    case "percentile":
      return "Percentile policy";
    case "target-horizon":
      return "Target horizon";
    case "profit-per-day":
      return "Profit per day";
  }
}
