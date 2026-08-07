import assert from "node:assert/strict";
import {
  getBatchSourcePriority,
  PRICING_JOB_PRIORITIES,
} from "./inventoryBatchPricingJobs.server";

assert.equal(
  getBatchSourcePriority("pending_inventory"),
  PRICING_JOB_PRIORITIES.pendingInventory,
);
assert.equal(getBatchSourcePriority("seller"), PRICING_JOB_PRIORITIES.operator);
assert.equal(getBatchSourcePriority("csv"), PRICING_JOB_PRIORITIES.operator);
assert.equal(
  getBatchSourcePriority("continuous"),
  PRICING_JOB_PRIORITIES.continuousRoutine,
);
assert.ok(
  PRICING_JOB_PRIORITIES.pendingInventory > PRICING_JOB_PRIORITIES.operator &&
    PRICING_JOB_PRIORITIES.operator >
      PRICING_JOB_PRIORITIES.continuousPriority &&
    PRICING_JOB_PRIORITIES.continuousPriority >
      PRICING_JOB_PRIORITIES.continuousRoutine,
);

console.log("PASS pricing job priorities preserve operator intent");
