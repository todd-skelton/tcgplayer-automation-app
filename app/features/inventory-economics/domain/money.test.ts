import assert from "node:assert/strict";
import { allocateAmountCents, dollarsToCents } from "./money";

assert.equal(dollarsToCents("0"), 0);
assert.equal(dollarsToCents("12.3"), 1230);
assert.throws(() => dollarsToCents("1.234"), /at most two/);

const allocated = allocateAmountCents(100, [
  { id: "receipt-2", weight: 1 },
  { id: "receipt-1", weight: 1 },
  { id: "receipt-3", weight: 1 },
]);
assert.deepEqual(allocated, [
  { id: "receipt-1", amountCents: 34 },
  { id: "receipt-2", amountCents: 33 },
  { id: "receipt-3", amountCents: 33 },
]);
assert.equal(allocated.reduce((sum, value) => sum + value.amountCents, 0), 100);
const large = allocateAmountCents(9_007_199_254_740_920, [
  { id: "a", weight: 72 }, { id: "b", weight: 3 }, { id: "c", weight: 7 },
]);
assert.equal(large.reduce((sum, value) => sum + value.amountCents, 0), 9_007_199_254_740_920);

console.log("PASS inventory economics allocates whole cents deterministically");
