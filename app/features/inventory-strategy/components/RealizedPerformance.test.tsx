import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { RealizedPerformance } from "./RealizedPerformance";
import { ImprovementLevers } from "./ImprovementLevers";
import { MarginTrend } from "./MarginTrend";
import { summarizeMarginTrend } from "../domain/marginTrend";
import { summarizeRealizedPerformance } from "../domain/realizedPerformance";

const lines = [
  { orderNumber: "A", soldAt: "2026-09-10T00:00:00.000Z", productLine: "Pokemon", quantity: 2, grossCents: 5000,
    netProceedsCents: 4000, costCents: 3000, daysHeld: 10, intakeMarketCents: 4400, saleMarketCents: 5000 },
  { orderNumber: "B", soldAt: "2026-09-12T00:00:00.000Z", productLine: "Pokemon", quantity: 1, grossCents: 700,
    netProceedsCents: null, costCents: 500, daysHeld: 3, intakeMarketCents: null, saleMarketCents: null },
];
const now = new Date("2026-09-17T00:00:00.000Z");
const report = summarizeRealizedPerformance(lines, { now, windowDays: [30, 90] });
const html = renderToStaticMarkup(<RealizedPerformance report={report} windowDays={30} onWindowChange={() => undefined} configuredHurdle={0.005} />);
assert.match(html, /Realized performance/);
assert.match(html, /3\.33%\/day on capital · hurdle 0\.50%\/day/);
assert.match(html, /\$10\.00 profit over 7 days/);
assert.match(html, /25\.0%/);
assert.match(html, /3 units/);
assert.match(html, /1 units \(\$7\.00 of \$57\.00 in sales\) without cost or proceeds excluded/);
assert.match(html, /Pokemon/);
assert.match(html, /30 days/);
assert.match(html, /90 days/);

const empty = renderToStaticMarkup(<RealizedPerformance report={null} error="Load failed" windowDays={30} onWindowChange={() => undefined} configuredHurdle={0.005} />);
assert.match(empty, /Load failed/);
assert.match(empty, /No sold units/);

const levers = renderToStaticMarkup(<ImprovementLevers levers={[{ title: "Raise the hurdle", detail: "Because." }]} />);
assert.match(levers, /How to improve/);
assert.match(levers, /Raise the hurdle/);
assert.match(renderToStaticMarkup(<ImprovementLevers levers={[]} />), /Nothing stands out/);

const trend = renderToStaticMarkup(<MarginTrend trend={{
  weeks: summarizeMarginTrend(lines, { now }),
  pricingChanges: [{ changedOn: "2026-09-08", changes: ["Policy: Profit per day at a 0.50%/day hurdle"] }],
}} />);
assert.match(trend, /Margin over time/);
assert.match(trend, /75% of the market price at intake less \$0\.30/);
assert.match(trend, /<svg/);
assert.match(trend, /Sep 8: Policy: Profit per day at a 0\.50%\/day hurdle/);
assert.match(trend, /Sep 14 \(so far\)/, "the current week is labeled as partial");
assert.match(trend, /Sep 7<\/td>/);
assert.match(trend, /88%/, "only the costed share of the week's sales is covered");
assert.match(trend, /25\.0%/);
assert.equal(renderToStaticMarkup(<MarginTrend trend={null} />), "");
console.log("PASS realized performance and levers render");
