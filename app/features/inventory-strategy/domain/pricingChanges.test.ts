import assert from "node:assert/strict";
import { describePricingChanges } from "./pricingChanges";

const percentile = { pricing: {}, supplyAnalysis: {}, productLinePricing: { defaultPercentile: 65 } };
const horizon = (horizonDays: number) => ({ ...percentile, pricing: { policy: { method: "target-horizon", horizonDays } } });
const profitPerDay = {
  ...percentile,
  pricing: { policy: { method: "profit-per-day" }, profitPerDay: { dailyReturnHurdle: 0.005, relativeOverhead: 0.15, staticOverheadPerUnit: 0.3 } },
};

const changes = describePricingChanges([
  { firstPricedAt: "2026-09-02T02:00:00.000Z", config: horizon(32), modelVersion: "exposure-share-v1" },
  { firstPricedAt: "2026-08-05T00:00:00.000Z", config: percentile, modelVersion: null },
  { firstPricedAt: "2026-09-02T20:00:00.000Z", config: horizon(24), modelVersion: "exposure-share-v1" },
  { firstPricedAt: "2026-09-03T18:00:00.000Z", config: profitPerDay, modelVersion: "exposure-share-v1" },
  { firstPricedAt: "2026-09-05T17:00:00.000Z", config: profitPerDay, modelVersion: "pooled-supply-v1" },
  { firstPricedAt: "2026-09-06T00:00:00.000Z", config: { ...profitPerDay, updatedAt: "ignored" }, modelVersion: "pooled-supply-v1" },
  { firstPricedAt: "2026-09-10T00:00:00.000Z",
    config: { ...profitPerDay, productLinePricing: { defaultPercentile: 70 } }, modelVersion: "pooled-supply-v1" },
], "2026-08-10");

assert.deepEqual(changes, [
  { changedOn: "2026-09-02", changes: ["Policy: Target horizon of 24 days", "Pricing model exposure-share-v1"] },
  { changedOn: "2026-09-03", changes: ["Policy: Profit per day at a 0.50%/day hurdle"] },
  { changedOn: "2026-09-05", changes: ["Pricing model pooled-supply-v1"] },
  { changedOn: "2026-09-10", changes: ["Product line settings (default 70th percentile)"] },
], "same-day changes compare the day's last configuration with the one before, and unchanged settings add nothing");

assert.deepEqual(describePricingChanges([
  { firstPricedAt: "2026-09-02T00:00:00.000Z", config: percentile, modelVersion: null },
  { firstPricedAt: "2026-09-03T00:00:00.000Z", config: horizon(30), modelVersion: null },
], "2026-09-04"), [], "changes before the trend starts are left out");
console.log("PASS pricing changes describe what changed on each day pricing changed");
