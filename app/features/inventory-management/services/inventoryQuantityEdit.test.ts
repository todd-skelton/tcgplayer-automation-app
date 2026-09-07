import assert from "node:assert/strict";
import {
  adjustDisplayedQuantity,
  finishQuantityEdit,
} from "./inventoryQuantityEdit";

assert.deepEqual(finishQuantityEdit(41, "34", 12, true), {
  displayValue: "34",
  commit: { sku: 41, quantity: 34, expectedQuantity: 12 },
});
assert.deepEqual(finishQuantityEdit(41, "", 12, true), {
  displayValue: "0",
  commit: { sku: 41, quantity: 0, expectedQuantity: 12 },
});
assert.equal(finishQuantityEdit(41, "12", 12, true).commit, null);
assert.equal(finishQuantityEdit(41, "99", 12, false).commit, null);
assert.deepEqual(adjustDisplayedQuantity("0", -1), {
  displayValue: "0",
  quantityDelta: 0,
});
assert.deepEqual(adjustDisplayedQuantity("3", -1), {
  displayValue: "2",
  quantityDelta: -1,
});
assert.deepEqual(adjustDisplayedQuantity("", 1), {
  displayValue: "1",
  quantityDelta: 1,
});

console.log("PASS quantity edits produce one normalized commit from their focus baseline");
