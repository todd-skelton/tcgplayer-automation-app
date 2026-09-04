import {
  INVENTORY_STRATEGY_MAX_PERCENTILE,
  INVENTORY_STRATEGY_MIN_PERCENTILE,
  type InventoryStrategyProductLine,
  type InventoryStrategyScenario,
} from "../types/inventoryStrategy";

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
