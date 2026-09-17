import assert from "node:assert/strict";
import { summarizeRealizedPerformance, type SoldUnitLine } from "./realizedPerformance";

const now = new Date("2026-09-17T00:00:00.000Z");
const line = (overrides: Partial<SoldUnitLine>): SoldUnitLine => ({
  orderNumber: "A", soldAt: "2026-09-10T00:00:00.000Z", productLine: "Pokemon", quantity: 1,
  netProceedsCents: 1000, costCents: 750, daysHeld: 10, ...overrides,
});

const report = summarizeRealizedPerformance([
  line({ orderNumber: "A" }),
  line({ orderNumber: "B", netProceedsCents: 2000, costCents: 1000, daysHeld: 20, quantity: 2 }),
  line({ orderNumber: "C", productLine: "YuGiOh", netProceedsCents: 500, costCents: 600, daysHeld: 40 }),
  line({ orderNumber: "D", costCents: null, quantity: 3 }),
  line({ orderNumber: "E", soldAt: "2026-06-01T00:00:00.000Z", netProceedsCents: 100, costCents: 50, daysHeld: 5 }),
], { now, windowDays: [30, 90] });

const [thirty, ninety] = report.windows;
assert.equal(report.firstSaleAt, "2026-06-01T00:00:00.000Z");
assert.equal(thirty.coveredDays, 30, "sales on record predate the 30-day window, so it is fully covered");
assert.equal(ninety.coveredDays, 90);

assert.equal(thirty.overall.unitsSold, 7);
assert.equal(thirty.overall.includedUnits, 4, "the uncosted lot is counted as sold but excluded from money");
assert.equal(thirty.overall.proceedsCents, 3500);
assert.equal(thirty.overall.costCents, 2350);
assert.equal(thirty.overall.profitCents, 1150);
assert.ok(Math.abs(thirty.overall.marginPercent! - (1150 / 3500) * 100) < 1e-9);
assert.ok(Math.abs(thirty.overall.markupPercent! - (1150 / 2350) * 100) < 1e-9);
assert.ok(Math.abs(thirty.overall.profitPerDayCents! - 1150 / 30) < 1e-9);
// cost-days: 750*10 + 1000*20 + 600*40 = 51,500
assert.ok(Math.abs(thirty.overall.dailyReturnPercent! - (1150 / 51_500) * 100) < 1e-9);
// held days weighted by units: 10 + 20*2 + 40 + 10*3 = 120 over 7 units
assert.ok(Math.abs(thirty.overall.averageDaysHeld! - 120 / 7) < 1e-9);

assert.deepEqual(thirty.productLines.map((summary) => summary.productLine), ["Pokemon", "YuGiOh"]);
assert.equal(thirty.productLines[1].profitCents, -100);
assert.ok(thirty.productLines[1].dailyReturnPercent! < 0);

assert.equal(ninety.overall.unitsSold, 7, "the June sale is outside 90 days");
assert.equal(ninety.overall.profitPerDayCents, 1150 / 90);

const negativeCost = summarizeRealizedPerformance([
  line({ netProceedsCents: 50, costCents: -20, daysHeld: 10 }),
], { now, windowDays: [30] }).windows[0].overall;
assert.equal(negativeCost.profitCents, 70);
assert.equal(negativeCost.dailyReturnPercent, null, "a lot the seller was paid to take ties up no capital");
assert.equal(negativeCost.markupPercent, null);

const recent = summarizeRealizedPerformance([line({ soldAt: "2026-09-12T00:00:00.000Z" })], { now, windowDays: [30] });
assert.equal(recent.windows[0].coveredDays, 5, "profit per day spreads over the days sales have been observed");

const empty = summarizeRealizedPerformance([], { now, windowDays: [30] }).windows[0];
assert.equal(empty.coveredDays, 0);
assert.equal(empty.overall.profitPerDayCents, null);
assert.equal(empty.overall.marginPercent, null);
console.log("PASS realized performance summarizes margin, profit per day, and return on capital by window and product line");
