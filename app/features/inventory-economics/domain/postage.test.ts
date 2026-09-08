import assert from "node:assert/strict";
import { allocatePurchasedPostage } from "./postage";

const allocated = allocatePurchasedPostage("seller-a", "USD", [
  { providerIdentity: "shp-out", orderNumbers: ["B", "A"], currency: "USD", rateCents: 501,
    linkedSellers: ["seller-a"], linkedOrderCount: 2 },
  { providerIdentity: "shp-out", orderNumbers: ["B", "A"], currency: "USD", rateCents: 501,
    linkedSellers: ["seller-a"], linkedOrderCount: 2 },
  { providerIdentity: "shp-return", orderNumbers: ["A"], currency: "USD", rateCents: 99,
    linkedSellers: ["seller-a"], linkedOrderCount: 1 },
  { providerIdentity: "cross-seller", orderNumbers: ["A", "C"], currency: "USD", rateCents: 800,
    linkedSellers: ["seller-a", "seller-b"], linkedOrderCount: 2 },
  { providerIdentity: "wrong-currency", orderNumbers: ["A"], currency: "CAD", rateCents: 100,
    linkedSellers: ["seller-a"], linkedOrderCount: 1 },
]);
assert.equal(allocated.get("A"), 350);
assert.equal(allocated.get("B"), 250);
assert.equal([...allocated.values()].reduce((sum, value) => sum + value, 0), 600);

console.log("PASS postage counts actual provider purchases once across full linked order groups");
