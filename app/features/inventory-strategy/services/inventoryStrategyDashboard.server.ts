import { inventoryStrategyRepository } from "~/core/db";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import type { ServerPricingConfig } from "~/features/pricing/types/config";
import type {
  InventoryStrategyDashboard,
  InventoryStrategySnapshotItem,
} from "../types/inventoryStrategy";
import { buildInventoryStrategyDashboard } from "./inventoryStrategy";
import { createVersionedCache } from "./versionedCache";

export interface InventoryStrategySource {
  findSnapshotVersion(sellerKey: string): Promise<string>;
  findSnapshot(sellerKey: string): Promise<InventoryStrategySnapshotItem[]>;
}

const dashboards = createVersionedCache<InventoryStrategyDashboard>(
  "Inventory strategy dashboard",
);

/**
 * The seller's dashboard. A changed pricing configuration waits for a
 * rebuild; changed inventory or curves, which every priced batch brings,
 * serve the last dashboard while the next one builds in the background.
 */
export async function loadInventoryStrategyDashboard(
  sellerKey: string,
  config: ServerPricingConfig,
  source: InventoryStrategySource = inventoryStrategyRepository,
): Promise<InventoryStrategyDashboard> {
  if (!sellerKey) return buildInventoryStrategyDashboard(sellerKey, [], config);
  return dashboards.read(
    sellerKey,
    [PRICING_MODEL_VERSION, JSON.stringify(config)].join("|"),
    await source.findSnapshotVersion(sellerKey),
    () =>
      source
        .findSnapshot(sellerKey)
        .then((items) =>
          buildInventoryStrategyDashboard(sellerKey, items, config),
        ),
  );
}
