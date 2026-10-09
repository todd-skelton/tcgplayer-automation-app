import { describePricingPolicy, formatPercentile } from "~/features/pricing/components/policyLabel";
import { activePricingPolicy, normalizeServerPricingConfig } from "~/features/pricing/types/config";

/** A pricing configuration and model version, and when a pricing job first used it. */
export interface PricingConfigurationUse {
  firstPricedAt: string;
  config: unknown;
  modelVersion: string | null;
}

/** What changed in how inventory was priced on one day. */
export interface PricingChange {
  /** UTC day of the change, as YYYY-MM-DD. */
  changedOn: string;
  changes: string[];
}

const json = (value: unknown) => JSON.stringify(value);

function describeChange(previous: PricingConfigurationUse, current: PricingConfigurationUse): string[] {
  const before = normalizeServerPricingConfig(previous.config);
  const after = normalizeServerPricingConfig(current.config);
  const changes: string[] = [];
  const policy = describePricingPolicy(activePricingPolicy(after.pricing));
  if (policy !== describePricingPolicy(activePricingPolicy(before.pricing))) changes.push(`Policy: ${policy}`);
  if (json(before.pricing.forecastCorrection) !== json(after.pricing.forecastCorrection)) {
    changes.push(after.pricing.forecastCorrection ? "Sell-time forecast correction applied" : "Sell-time forecast correction removed");
  }
  if (json(before.productLinePricing) !== json(after.productLinePricing)) {
    changes.push(`Product line settings (default ${formatPercentile(after.productLinePricing.defaultPercentile)} percentile)`);
  }
  if (current.modelVersion && current.modelVersion !== previous.modelVersion) changes.push(`Pricing model ${current.modelVersion}`);
  if (!changes.length && json(before) !== json(after)) changes.push("Pricing settings");
  return changes;
}

/**
 * The days pricing changed on or after `since` (YYYY-MM-DD): the last
 * configuration first used that day compared with the one in use before it.
 */
export function describePricingChanges(history: readonly PricingConfigurationUse[], since: string): PricingChange[] {
  const ordered = [...history].sort((left, right) => left.firstPricedAt.localeCompare(right.firstPricedAt));
  const lastOfDay = new Map<string, PricingConfigurationUse>();
  for (const use of ordered) lastOfDay.set(use.firstPricedAt.slice(0, 10), use);
  const days = [...lastOfDay.entries()];
  return days.flatMap(([changedOn, current], index) => {
    if (index === 0 || changedOn < since) return [];
    const changes = describeChange(days[index - 1][1], current);
    return changes.length ? [{ changedOn, changes }] : [];
  });
}
