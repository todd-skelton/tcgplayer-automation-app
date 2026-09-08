import assert from "node:assert/strict";
import { normalizePurchaseCostDetails } from "./purchaseCostDetails";

const details = {
  requestId:" request-1 ",sellerKey:" seller-1 ",purchaseReference:" invoice-1 ",
  currency:" usd ",totalAmountCents:0,provenance:"actual",source:"intake",
  allocationRule:"quantity",purchasedAt:"",
};
assert.deepEqual(normalizePurchaseCostDetails(details),{
  requestId:"request-1",sellerKey:"seller-1",purchaseReference:"invoice-1",
  currency:"USD",totalAmountCents:0,provenance:"actual",source:"intake",allocationRule:"quantity",
});
for (const purchasedAt of ["not-a-date","2026-02-29","2026-04-31"]) {
  assert.throws(()=>normalizePurchaseCostDetails({...details,purchasedAt}),/calendar date/);
}
assert.throws(()=>normalizePurchaseCostDetails({...details,requestId:"r".repeat(201)}),/200 characters/);
assert.throws(()=>normalizePurchaseCostDetails({...details,currency:"US"}),/three-letter/);
assert.throws(()=>normalizePurchaseCostDetails({...details,purchasedAt:42}),/must be text/);
assert.throws(()=>normalizePurchaseCostDetails({...details,allocationRule:"frozen_market"}),/market evidence instant/);
assert.equal("marketObservedAt" in normalizePurchaseCostDetails({...details,marketObservedAt:"stale"}),false);
assert.equal("marketObservedAt" in normalizePurchaseCostDetails({
  ...details,allocationRule:"explicit",marketObservedAt:"stale",
}),false);
assert.equal(normalizePurchaseCostDetails({
  ...details,allocationRule:"frozen_market",marketObservedAt:"2026-08-02T12:00:00-05:00",
}).marketObservedAt,"2026-08-02T17:00:00.000Z");

console.log("PASS purchase details require frozen evidence and ignore it for other rules");
