import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SaleValueFigures } from "./SaleValueFigures";

const visibleText = (html: string) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "");

const complete = renderToStaticMarkup(
  <SaleValueFigures
    value={{
      price: 16,
      market: { price: 6, total: 8, difference: -2, percent: -25, partial: null },
      intake: { price: 6, total: 5, difference: 1, percent: 20, partial: null },
      ageDays: 10,
      agePartial: null,
    }}
  />,
);
const text = visibleText(complete);
assert.match(text, /Price\$16\.00/);
assert.match(text, /Market\$8\.00 -\$2\.00 -25\.0%/);
assert.match(text, /IntakePrice\$6\.00 Market\$5\.00 \+\$1\.00 \+20\.0%/);
assert.match(text, /Age10\.0d/);
assert.doesNotMatch(text, /\*/);

const partialIntake = visibleText(renderToStaticMarkup(
  <SaleValueFigures
    value={{
      price: 791.66,
      market: { price: 791.66, total: 708.47, difference: 83.19, percent: 11.742, partial: null },
      intake: { price: 647.12, total: 609, difference: 38.12, percent: 6.2594, partial: "40 of 48 units have an intake price" },
      ageDays: 32.8,
      agePartial: "40 of 48 units have an intake date",
    }}
  />,
));
assert.match(
  partialIntake,
  /IntakePrice\$647\.12 Market\$609\.00 \+\$38\.12 \+6\.3%\*/,
  "a partial intake shows the sale price of only the units it compares",
);

const sparse = visibleText(renderToStaticMarkup(
  <SaleValueFigures
    value={{
      price: 9,
      market: { price: 6, total: 8, difference: -2, percent: -25, partial: "1 of 2 lines priced" },
      intake: null,
      ageDays: null,
      agePartial: null,
    }}
  />,
));
assert.match(sparse, /-25\.0%\*/, "a partial comparison is marked");
assert.match(sparse, /Intake-/);
assert.match(sparse, /Age-/);

console.log("PASS sale value figures show price, market, intake, and age with absolute and relative differences");
