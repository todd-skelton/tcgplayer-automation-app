import assert from "node:assert/strict";
import { reducePendingReceipts } from "./receiptBalances";

assert.deepEqual(
  reducePendingReceipts(
    [
      { receiptId: 3, quantity: 2 },
      { receiptId: 2, quantity: 1 },
      { receiptId: 1, quantity: 4 },
    ],
    5,
  ),
  [
    { receiptId: 3, quantityDelta: -2 },
    { receiptId: 2, quantityDelta: -1 },
    { receiptId: 1, quantityDelta: -2 },
  ],
);
assert.deepEqual(reducePendingReceipts([{ receiptId: 1, quantity: 1 }], 0), []);
assert.throws(
  () => reducePendingReceipts([{ receiptId: 1, quantity: 1 }], 2),
  /more than the pending quantity/,
);

console.log("PASS pending receipt reductions preserve receipt quantities");
