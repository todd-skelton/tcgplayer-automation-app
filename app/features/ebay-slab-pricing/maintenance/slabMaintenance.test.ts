import assert from "node:assert/strict";
import {
  automaticSlabPublication,
  defaultMaintenanceSettings,
  maintenanceSettings,
} from "./slabMaintenance";
import { maintenanceWindow } from "./slabMaintenanceCycle.server";
const defaults = defaultMaintenanceSettings("PokeBash");
assert.equal(defaults.enabled, false);
assert.equal(defaults.seller, "pokebash");
assert.deepEqual(maintenanceSettings(defaults), defaults);
for (const value of [
  { intervalMinutes: 0 },
  { intervalMinutes: 1441 },
  { batchSize: 0 },
  { batchSize: 26 },
  { refreshBudget: 0 },
  { refreshBudget: 51 },
  { revision: -1 },
  { enabled: "true" },
])
  assert.throws(() =>
    maintenanceSettings({ ...defaults, ...value } as typeof defaults),
  );
assert.equal(automaticSlabPublication().enabled, false);
assert.deepEqual(maintenanceWindow(new Date("2026-09-06T01:00:00Z")), {
  from: "2025-09-05",
  to: "2026-09-05",
});
console.log(
  "PASS opt-in maintenance defaults, bounded settings, Chicago windows and unavailable automatic publication",
);
