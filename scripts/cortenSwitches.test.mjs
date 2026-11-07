import assert from "node:assert/strict";
import { CORTEN_SWITCHES, unsetSwitches } from "./cortenSwitches.mjs";

assert.deepEqual(unsetSwitches({}), CORTEN_SWITCHES, "with no switch set every one is missing");
assert.deepEqual(
  unsetSwitches({ SELLER_ORDER_HISTORY_WORKER: "1", PRICING_WORKER: "1" }),
  ["CONTINUOUS_PRICING_SCHEDULER", "SLAB_EVIDENCE_WORKER", "PUBLICATION_WORKER", "MIGRATE_ON_START"],
  "after release 3 the schedule, slab, publication and migration switches are still missing",
);
assert.deepEqual(
  unsetSwitches(Object.fromEntries(CORTEN_SWITCHES.map((name) => [name, name === "MIGRATE_ON_START" ? " " : "1"]))),
  ["MIGRATE_ON_START"],
  "a blank switch is unset, as the Corten app reads it",
);
assert.deepEqual(unsetSwitches(Object.fromEntries(CORTEN_SWITCHES.map((name) => [name, "1"]))), []);
