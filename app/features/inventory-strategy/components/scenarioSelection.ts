import {
  INVENTORY_STRATEGY_MAX_PERCENTILE,
  INVENTORY_STRATEGY_MIN_PERCENTILE,
  type InventoryStrategyProductLine,
  type InventoryStrategyScenario,
} from "../types/inventoryStrategy";
import { formatPercentile } from "./format";

/** The product line's estimated knee percentile with its range, or that none is available. */
export function formatKneeEstimate(
  productLine: InventoryStrategyProductLine,
): string {
  if (productLine.estimatedPercentile === null) {
    return "Estimate unavailable";
  }
  const estimate = formatPercentile(productLine.estimatedPercentile);
  if (
    productLine.kneeRangeMinimum === null ||
    productLine.kneeRangeMaximum === null ||
    productLine.kneeRangeMinimum === productLine.kneeRangeMaximum
  ) {
    return `Estimated ${estimate}`;
  }
  return `Estimated ${estimate} · ${formatPercentile(productLine.kneeRangeMinimum)}–${formatPercentile(productLine.kneeRangeMaximum)} range`;
}

export function findScenario(
  productLine: InventoryStrategyProductLine,
  percentile: number,
): InventoryStrategyScenario | undefined {
  return productLine.scenarios.find(
    (scenario) => scenario.percentile === percentile,
  );
}

/** The configured percentile within the scenario range, or the 80th without one. */
export function defaultSelection(
  productLine: InventoryStrategyProductLine,
): number {
  const configured = productLine.configuredPercentile;
  if (configured !== null) {
    return Math.min(
      INVENTORY_STRATEGY_MAX_PERCENTILE,
      Math.max(INVENTORY_STRATEGY_MIN_PERCENTILE, configured),
    );
  }
  return 80;
}
