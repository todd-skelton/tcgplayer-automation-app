import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SaleValueFigures } from "./SaleValueFigures";

const visibleText = (html: string) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "");

const complete = renderToStaticMarkup(
  <SaleValueFigures
    value={{
      price: 16,
      market: { total: 8, difference: -2, percent: -25, partial: null },
      intake: { total: 5, difference: 1, percent: 20, partial: null },
      ageDays: 10,
      agePartial: null,
    }}
  />,
);
const text = visibleText(complete);
assert.match(text, /Price\$16\.00/);
assert.match(text, /Market\$8\.00 -\$2\.00 -25\.0%/);
assert.match(text, /Intake\$5\.00 \+\$1\.00 \+20\.0%/);
assert.match(text, /Age10\.0d/);
assert.doesNotMatch(text, /\*/);

const sparse = visibleText(renderToStaticMarkup(
  <SaleValueFigures
    value={{
      price: 9,
      market: { total: 8, difference: -2, percent: -25, partial: "1 of 2 lines priced" },
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
