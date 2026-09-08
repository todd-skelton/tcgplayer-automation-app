import assert from "node:assert/strict";
import { parseIntakePurchaseCost } from "./api.inventory-batches";

const valid = { purchaseReference:" invoice ",totalAmount:"0.00",provenance:"actual",
  allocationRule:"quantity",currency:" usd ",purchasedAt:"" };
assert.deepEqual(parseIntakePurchaseCost(valid,"batch-request"," seller "),{
  requestId:"batch-request:purchase-cost",sellerKey:"seller",purchaseReference:"invoice",
  totalAmountCents:0,provenance:"actual",source:"intake",allocationRule:"quantity",currency:"USD",
});
for (const purchasedAt of ["not-a-date","2026-02-29","2026-09-31"]) {
  assert.throws(()=>parseIntakePurchaseCost({...valid,purchasedAt},"batch-request","seller"),/calendar date/);
}
assert.throws(()=>parseIntakePurchaseCost({...valid,currency:"US"},"batch-request","seller"),/three-letter/);
assert.throws(()=>parseIntakePurchaseCost(valid,"x".repeat(190),"seller"),/200 characters/);
assert.throws(()=>parseIntakePurchaseCost({...valid,allocationRule:"frozen_market"},"batch-request","seller"),/quantity allocation/);

console.log("PASS intake purchase details normalize completely before batch creation");
