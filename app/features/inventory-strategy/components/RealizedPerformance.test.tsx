import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { RealizedPerformance } from "./RealizedPerformance";
import { ImprovementLevers } from "./ImprovementLevers";
import { summarizeRealizedPerformance } from "../domain/realizedPerformance";

const report = summarizeRealizedPerformance([
  { orderNumber: "A", soldAt: "2026-09-10T00:00:00.000Z", productLine: "Pokemon", quantity: 2, netProceedsCents: 4000, costCents: 3000, daysHeld: 10 },
  { orderNumber: "B", soldAt: "2026-09-12T00:00:00.000Z", productLine: "Pokemon", quantity: 1, netProceedsCents: null, costCents: 500, daysHeld: 3 },
], { now: new Date("2026-09-17T00:00:00.000Z"), windowDays: [30, 90] });
const html = renderToStaticMarkup(<RealizedPerformance report={report} windowDays={30} onWindowChange={() => undefined} configuredHurdle={0.005} />);
assert.match(html, /Realized performance/);
assert.match(html, /3\.33%\/day on capital · hurdle 0\.50%\/day/);
assert.match(html, /\$10\.00 profit over 7 days/);
assert.match(html, /25\.0%/);
assert.match(html, /3 units/);
assert.match(html, /1 units without cost or proceeds excluded/);
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
console.log("PASS realized performance and levers render");
