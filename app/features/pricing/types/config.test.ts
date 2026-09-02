import assert from "node:assert/strict";
import { normalizeServerPricingConfig } from "./config";

assert.deepEqual(
  normalizeServerPricingConfig({
    pricing: { policy: { method: "target-horizon", horizonDays: 33.5 } },
  }).pricing.policy,
  { method: "target-horizon", horizonDays: 33.5 },
);
assert.deepEqual(
  normalizeServerPricingConfig({
    pricing: { policy: { method: "target-horizon", horizonDays: 0 } },
  }).pricing.policy,
  { method: "percentile" },
);

console.log("PASS pricing policy configuration is normalized safely");
