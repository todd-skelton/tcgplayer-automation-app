import assert from "node:assert/strict";
import { purchaseCapital } from "./purchaseCapital";

const same = purchaseCapital([{ receiptId: 1, amountCents: 700 }, { receiptId: 2, amountCents: 0 }, { receiptId: 3, amountCents: 5 }]);
assert.equal(same.totalAmountCents, 705);
assert.deepEqual([...same.lotAmountCents], [[1, 700], [2, 0], [3, 5]], "nonnegative purchases are unchanged");

const netted = purchaseCapital([{ receiptId: 1, amountCents: 600 }, { receiptId: 2, amountCents: 300 }, { receiptId: 3, amountCents: -90 }]);
assert.equal(netted.totalAmountCents, 810);
assert.deepEqual([...netted.lotAmountCents], [[1, 540], [2, 270], [3, 0]], "negative lots offset the positive ones");

const paid = purchaseCapital([{ receiptId: 1, amountCents: -20 }, { receiptId: 2, amountCents: -30 }]);
assert.equal(paid.totalAmountCents, 0);
assert.deepEqual([...paid.lotAmountCents], [[1, 0], [2, 0]], "a purchase that paid the buyer ties up no capital");

console.log("PASS purchase capital nets negative lot costs into the positive lots");