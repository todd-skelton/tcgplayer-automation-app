import assert from "node:assert/strict";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { loadInventoryStrategyDashboard } from "./inventoryStrategyDashboard.server";

let version = "inventory-1";
let snapshotReads = 0;
const source = {
  findSnapshotVersion: async () => version,
  findSnapshot: async () => {
    snapshotReads += 1;
    return [];
  },
};

const first = await loadInventoryStrategyDashboard(
  "seller",
  DEFAULT_SERVER_PRICING_CONFIG,
  source,
);
const second = await loadInventoryStrategyDashboard(
  "seller",
  DEFAULT_SERVER_PRICING_CONFIG,
  source,
);
assert.equal(second, first, "an unchanged version serves the cached dashboard");
assert.equal(snapshotReads, 1);

version = "inventory-2";
const rebuilt = await loadInventoryStrategyDashboard(
  "seller",
  DEFAULT_SERVER_PRICING_CONFIG,
  source,
);
assert.notEqual(rebuilt, first, "a changed inventory version rebuilds");
assert.equal(snapshotReads, 2);

const reconfigured = await loadInventoryStrategyDashboard(
  "seller",
  {
    ...DEFAULT_SERVER_PRICING_CONFIG,
    pricing: {
      ...DEFAULT_SERVER_PRICING_CONFIG.pricing,
      policy: { method: "profit-per-day" },
    },
  },
  source,
);
assert.notEqual(reconfigured, rebuilt, "a changed configuration rebuilds");
assert.equal(snapshotReads, 3);

const empty = await loadInventoryStrategyDashboard(
  "",
  DEFAULT_SERVER_PRICING_CONFIG,
  source,
);
assert.equal(empty.productLines.length, 0);
assert.equal(snapshotReads, 3, "no seller means no snapshot read");

console.log(
  "PASS inventory strategy dashboard is rebuilt only when its inputs change",
);
