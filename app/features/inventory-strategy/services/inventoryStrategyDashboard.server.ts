import { inventoryStrategyRepository } from "~/core/db";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import type { ServerPricingConfig } from "~/features/pricing/types/config";
import type {
  InventoryStrategyDashboard,
  InventoryStrategySnapshotItem,
} from "../types/inventoryStrategy";
import { buildInventoryStrategyDashboard } from "./inventoryStrategy";

export interface InventoryStrategySource {
  findSnapshotVersion(sellerKey: string): Promise<string>;
  findSnapshot(sellerKey: string): Promise<InventoryStrategySnapshotItem[]>;
}

const dashboards = new Map<
  string,
  { version: string; dashboard: Promise<InventoryStrategyDashboard> }
>();

/**
 * The seller's dashboard, rebuilt only when the inventory, its curves, or the
 * pricing configuration changed since the last build.
 */
export async function loadInventoryStrategyDashboard(
  sellerKey: string,
  config: ServerPricingConfig,
  source: InventoryStrategySource = inventoryStrategyRepository,
): Promise<InventoryStrategyDashboard> {
  if (!sellerKey) return buildInventoryStrategyDashboard(sellerKey, [], config);
  const version = [
    PRICING_MODEL_VERSION,
    await source.findSnapshotVersion(sellerKey),
    JSON.stringify(config),
  ].join("|");
  const cached = dashboards.get(sellerKey);
  if (cached?.version === version) return cached.dashboard;
  const dashboard = source
    .findSnapshot(sellerKey)
    .then((items) => buildInventoryStrategyDashboard(sellerKey, items, config));
  dashboards.set(sellerKey, { version, dashboard });
  dashboard.catch(() => {
    if (dashboards.get(sellerKey)?.dashboard === dashboard)
      dashboards.delete(sellerKey);
  });
  return dashboard;
}
