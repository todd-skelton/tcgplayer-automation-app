import assert from "node:assert/strict";
import { normalizeContinuousPricingSettings } from "./continuousPricingSettings";

const defaults = normalizeContinuousPricingSettings(undefined);
assert.equal(defaults.enabled, false);
assert.equal(defaults.minimumIntervalMinutes, 24 * 60);

const normalized = normalizeContinuousPricingSettings({
  enabled: true,
  sellerKey: "  test-seller  ",
  minimumIntervalMinutes: 60,
  inventoryRefreshMinutes: 15,
  schedulerPollSeconds: 10,
  batchSize: 750,
});
assert.deepEqual(normalized, {
  enabled: true,
  sellerKey: "test-seller",
  minimumIntervalMinutes: 60,
  inventoryRefreshMinutes: 15,
  schedulerPollSeconds: 10,
  batchSize: 750,
});

const invalid = normalizeContinuousPricingSettings({
  minimumIntervalMinutes: 1,
  batchSize: 751,
});
assert.equal(invalid.minimumIntervalMinutes, 24 * 60);
assert.equal(invalid.batchSize, 100);

console.log(
  "PASS continuous pricing settings enforce cadence and batch limits",
);
