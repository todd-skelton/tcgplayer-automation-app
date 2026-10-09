import assert from "node:assert/strict";
import { summarizeMarginDrivers, summarizeMarginTrend } from "./marginTrend";
import type { SoldUnitLine } from "./realizedPerformance";

const line = (overrides: Partial<SoldUnitLine>): SoldUnitLine => ({
  orderNumber: "A", soldAt: "2026-09-09T12:00:00.000Z", productLine: "Pokemon", quantity: 1, grossCents: 1000,
  netProceedsCents: 800, costCents: 700, daysHeld: 10, intakeMarketCents: 1000, saleMarketCents: 1000, ...overrides,
});

// Thursday, October 8; weeks start on Mondays (September 7 is one).
const now = new Date("2026-10-08T00:00:00.000Z");
const weeks = summarizeMarginTrend([
  line({ soldAt: "2026-09-07T03:00:00.000Z" }),
  line({ soldAt: "2026-09-20T23:00:00.000Z", netProceedsCents: 1000, costCents: 700 }),
  line({ soldAt: "2026-09-29T00:00:00.000Z", netProceedsCents: 800, costCents: 760 }),
  line({ soldAt: "2026-10-06T00:00:00.000Z", costCents: null }),
  line({ soldAt: "2026-10-07T00:00:00.000Z", netProceedsCents: 800, costCents: 600 }),
], { now });

assert.deepEqual(weeks.map((week) => week.weekStart), ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"],
  "every week from the first sale to the current week, including weeks without sales");
assert.equal(weeks[0].summary.unitsSold, 1);
assert.equal(weeks[1].summary.unitsSold, 1, "a Sunday sale stays in the week it was made");
assert.equal(weeks[2].summary.unitsSold, 0);
assert.equal(weeks[2].summary.marginPercent, null);
assert.ok(Math.abs(weeks[3].summary.marginPercent! - 5) < 1e-9);
assert.ok(Math.abs(weeks[0].coveredDays - (7 - 3 / 24)) < 1e-9, "the first week covers only the days since the first sale");
assert.equal(weeks[4].coveredDays, 3, "the current week covers only the days so far");
assert.deepEqual(weeks.map((week) => week.ended), [true, true, true, true, false]);
assert.equal(weeks[4].summary.includedUnits, 1);
assert.equal(weeks[4].summary.includedGrossCents / weeks[4].summary.grossCents, 0.5);

// Trailing four weeks ending with Sep 28: Sep 7, Sep 20, and Sep 29 sales; proceeds 2,600 and cost 2,160.
assert.ok(Math.abs(weeks[3].trailingMarginPercent! - (440 / 2600) * 100) < 1e-9);
// Ending with Oct 5: Sep 20, Sep 29, Oct 7 (the uncosted sale is excluded); proceeds 2,600 and cost 2,060.
assert.ok(Math.abs(weeks[4].trailingMarginPercent! - (540 / 2600) * 100) < 1e-9);

assert.equal(summarizeMarginTrend([line({ soldAt: "2026-01-05T00:00:00.000Z" })], { now, weeks: 3 })[0].weekStart, "2026-09-21",
  "the trend reaches back only the requested number of weeks");
assert.deepEqual(summarizeMarginTrend([], { now }), []);

const drivers = summarizeMarginDrivers([
  line({ quantity: 2, grossCents: 2100, netProceedsCents: 1700, intakeMarketCents: 2000, saleMarketCents: 1900 }),
  line({ grossCents: 900, netProceedsCents: 700, intakeMarketCents: 1000, saleMarketCents: 1100 }),
  line({ grossCents: 500, netProceedsCents: 400, intakeMarketCents: null, saleMarketCents: 600 }),
  line({ grossCents: 500, netProceedsCents: 400, costCents: null }),
]);
assert.equal(drivers.marketPricedUnits, 3, "only included units with both market prices are compared with the market");
assert.equal(drivers.priceToMarketPercent, 100, "3,000 sold against 3,000 of market at sale");
assert.ok(Math.abs(drivers.marketChangePercent! - 100) < 1e-9, "3,000 of market at sale against 3,000 at intake");
assert.ok(Math.abs(drivers.netToGrossPercent! - (2800 / 3500) * 100) < 1e-9, "net over gross covers every included unit");
const unpriced = summarizeMarginDrivers([line({ intakeMarketCents: null })]);
assert.equal(unpriced.priceToMarketPercent, null);
assert.equal(unpriced.marketChangePercent, null);
assert.equal(unpriced.netToGrossPercent, 80);
console.log("PASS margin trend summarizes weekly margin, the trailing margin, and its drivers");
