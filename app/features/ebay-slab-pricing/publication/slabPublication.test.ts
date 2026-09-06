import assert from "node:assert/strict";
import { publicationRequest } from "./publicationRequest";
import {
  listingState,
  listingConflicts,
  type SellerListingState,
} from "./slabPublication";
const row: SellerListingState = {
  seller: "fixture",
  accountSeller: "fixture",
  itemId: "123456789012",
  variationKey: "",
  price: { amount: 100, currency: "USD" },
  quantity: 1,
  state: "active",
  format: "fixed-price",
  certificate: { grader: "PSA", certificateNumber: "12345678" },
  title: "Fixture slab",
  shipping: { amount: 0, currency: "USD", policyId: null },
  protectedRevision: "a".repeat(64),
  observedAt: "2026-09-06T12:00:00.000Z",
  supported: true,
};
const plan = {
  target: { seller: row.seller, itemId: row.itemId, variationKey: "" },
  certificate: row.certificate!,
  before: row,
};
assert.deepEqual(listingConflicts(plan, row, row.price, row.observedAt), []);
for (const [patch, reason] of [
  [{ seller: "other" }, "wrong-seller"],
  [{ accountSeller: "other" }, "wrong-seller"],
  [{ itemId: "123456789013" }, "wrong-listing"],
  [{ variationKey: "variation" }, "unsupported-listing"],
  [{ supported: false }, "unsupported-listing"],
  [{ format: "auction" }, "unsupported-listing"],
  [{ quantity: 0 }, "listing-unavailable"],
  [{ quantity: 2 }, "listing-unavailable"],
  [{ state: "sold" }, "listing-unavailable"],
  [{ state: "ended" }, "listing-unavailable"],
  [{ price: { amount: 101, currency: "USD" } }, "price-changed"],
  [{ price: { amount: 100, currency: "CAD" } }, "price-changed"],
  [{ certificate: null }, "certificate-changed"],
  [{ protectedRevision: "b".repeat(64) }, "listing-settings-changed"],
  [{ title: "Other card" }, "listing-settings-changed"],
  [
    { shipping: { amount: 5, currency: "USD", policyId: null } },
    "listing-settings-changed",
  ],
  [{ observedAt: "2026-09-06T11:58:00.000Z" }, "listing-read-stale"],
  [{ observedAt: "2026-09-06T12:01:00.000Z" }, "listing-read-stale"],
] as Array<[Partial<SellerListingState>, string]>)
  assert.ok(
    listingConflicts(
      plan,
      { ...row, ...patch },
      row.price,
      row.observedAt,
    ).includes(reason),
    reason,
  );
assert.ok(
  listingConflicts(
    plan,
    row,
    row.price,
    row.observedAt,
    "2026-09-06T12:00:00.001Z",
  ).includes("listing-read-stale"),
);
assert.throws(() => listingState({ ...row, protectedRevision: "unverified" }));
assert.throws(() => listingState({ ...row, quantity: NaN }));
assert.throws(() =>
  listingState({
    ...row,
    shipping: { amount: 0, currency: "USD", policyId: "x".repeat(81) },
  }),
);
const sanitized = listingState({
  ...row,
  authorization: "SYNTHETIC-DO-NOT-STORE",
  rawBody: "SYNTHETIC",
} as SellerListingState);
assert.ok(!("authorization" in sanitized) && !("rawBody" in sanitized));
console.log(
  "PASS publication target/account/identity/settings/price/freshness gates and normalized outcome whitelisting",
);
let capturedSignal: AbortSignal | undefined;
await assert.rejects(() =>
  publicationRequest((signal) => {
    capturedSignal = signal;
    return new Promise(() => {});
  }, 5),
);
assert.equal(
  capturedSignal?.aborted,
  true,
  "Ignoring cancellation does not remove the request time bound",
);
