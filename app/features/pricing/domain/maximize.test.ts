import assert from "node:assert/strict";
import { maximizeOverCandidates } from "./maximize";

const grid = Array.from({ length: 11 }, (_, index) => index);

const interior = maximizeOverCandidates(grid, (x) => -((x - 3.3) ** 2));
assert.ok(interior);
assert.ok(
  Math.abs(interior.argument - 3.3) < 1e-4,
  `refinement finds the peak between candidates, got ${interior.argument}`,
);

const boundary = maximizeOverCandidates(grid, (x) => x);
assert.ok(boundary);
assert.equal(
  boundary.argument,
  10,
  "a peak on the last candidate is returned exactly",
);

const twoPeaks = maximizeOverCandidates(
  grid,
  (x) => Math.exp(-((x - 1) ** 2)) + 2 * Math.exp(-((x - 8) ** 2)),
);
assert.ok(twoPeaks);
assert.ok(
  Math.abs(twoPeaks.argument - 8) < 1e-4,
  "scanning first keeps the search out of the lower peak",
);

assert.deepEqual(
  maximizeOverCandidates([4], (x) => x * 2),
  {
    argument: 4,
    value: 8,
  },
);
assert.equal(
  maximizeOverCandidates([], (x) => x),
  undefined,
);
assert.equal(
  maximizeOverCandidates([1, 2], () => Number.NaN),
  undefined,
);

console.log("PASS maximizer scans candidates and sharpens the best stretch");
