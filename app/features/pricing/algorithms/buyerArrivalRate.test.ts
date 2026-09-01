import assert from "node:assert/strict";
import {
  estimateBuyerArrivalAtPrice,
  LATEST_SALES_LIMIT,
} from "./buyerArrivalRate";

const day = 24 * 60 * 60 * 1000;
const asOfTimestamp = new Date("2026-08-31T00:00:00.000Z").getTime();
const sale = (price: number, ageDays: number) => ({
  price,
  timestamp: asOfTimestamp - ageDays * day,
});

const sparse = estimateBuyerArrivalAtPrice([sale(10, 1), sale(10, 2)], 10, {
  asOfTimestamp,
  halfLifeDays: Infinity,
});
assert.equal(sparse.intervalDays, 45);
assert.equal(sparse.observationDays, 90);
assert.equal(sparse.historyCapped, false);
assert.equal(sparse.exposureStartReason, "history-window");

const recentlyAvailable = estimateBuyerArrivalAtPrice(
  [sale(10, 1), sale(10, 2)],
  10,
  {
    asOfTimestamp,
    halfLifeDays: Infinity,
    availableSinceTimestamp: asOfTimestamp - 10 * day,
  },
);
assert.equal(recentlyAvailable.intervalDays, 5);
assert.equal(recentlyAvailable.observationDays, 10);
assert.equal(recentlyAvailable.exposureStartReason, "availability");

const presale = estimateBuyerArrivalAtPrice([sale(10, 1), sale(10, 2)], 10, {
  asOfTimestamp,
  halfLifeDays: Infinity,
  availableSinceTimestamp: asOfTimestamp + 10 * day,
});
assert.equal(presale.qualifyingSalesCount, 2);
assert.equal(presale.observationDays, 2);
assert.equal(presale.intervalDays, 1);
assert.equal(
  presale.exposureStartReason,
  "availability",
  "an observed presale proves that the market was available before release",
);

const cappedSales = Array.from({ length: LATEST_SALES_LIMIT }, (_, index) =>
  sale(10, (2 * index) / (LATEST_SALES_LIMIT - 1)),
);
const capped = estimateBuyerArrivalAtPrice(cappedSales, 10, {
  asOfTimestamp,
  halfLifeDays: Infinity,
});
assert.ok(Math.abs((capped.intervalDays ?? 0) - 0.02) < 1e-10);
assert.equal(capped.observationDays, 2);
assert.equal(capped.historyCapped, true);
assert.equal(capped.exposureStartReason, "sales-cap");

const noQualifyingSales = estimateBuyerArrivalAtPrice(
  [sale(5, 1), sale(5, 2)],
  10,
  { asOfTimestamp, halfLifeDays: 7 },
);
assert.equal(noQualifyingSales.intervalDays, undefined);
assert.equal(noQualifyingSales.qualifyingSalesCount, 0);

const decayed = estimateBuyerArrivalAtPrice([sale(10, 0), sale(10, 14)], 10, {
  asOfTimestamp,
  halfLifeDays: 7,
});
assert.ok((decayed.weightedSalesCount ?? 0) > 1);
assert.ok((decayed.weightedSalesCount ?? 0) < 2);
assert.ok((decayed.effectiveExposureDays ?? 0) < decayed.observationDays);

console.log("PASS buyer arrival uses observed exposure and API censoring");
