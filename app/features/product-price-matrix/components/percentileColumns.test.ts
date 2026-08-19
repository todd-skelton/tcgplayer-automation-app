import assert from "node:assert/strict";
import {
  formatPercentileLabel,
  getAvailablePercentiles,
  getConfiguredPercentiles,
} from "./percentileColumns";

const cells = [
  {
    percentileUsed: 70,
    percentiles: [
      { percentile: 70, suggestedPrice: 12 },
      { percentile: 10, suggestedPrice: 8 },
      { percentile: 50, suggestedPrice: 10 },
    ],
  },
  {
    percentileUsed: 70,
    percentiles: [
      { percentile: 10, suggestedPrice: 7 },
      { percentile: 90, suggestedPrice: 15 },
    ],
  },
  {
    percentileUsed: 65,
  },
];

assert.deepEqual(getAvailablePercentiles(cells), [10, 50, 65, 70, 90]);
assert.deepEqual(getConfiguredPercentiles(cells), [65, 70]);
assert.equal(formatPercentileLabel(1), "1st");
assert.equal(formatPercentileLabel(2), "2nd");
assert.equal(formatPercentileLabel(3), "3rd");
assert.equal(formatPercentileLabel(11), "11th");
assert.equal(formatPercentileLabel(70), "70th");

console.log(
  "PASS product price matrix percentile columns stay complete and ordered",
);
