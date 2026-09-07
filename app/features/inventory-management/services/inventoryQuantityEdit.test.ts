import assert from "node:assert/strict";
import { finishQuantityEdit } from "./inventoryQuantityEdit";

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

console.log("PASS quantity edits produce one normalized commit from their focus baseline");
