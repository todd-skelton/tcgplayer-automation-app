import assert from "node:assert/strict";
import Papa from "papaparse";
import { parseSellerOutcomeCsv } from "./sellerOutcomeCsv.server";
import { reconcileSellerOutcomes } from "./supplyContext";
const row = {
  event_id: "sale-1",
  item_id: "090000000001",
  kind: "sale",
  occurred_at: "2026-09-01T12:00:00Z",
  quantity: "1",
  price: "125.25",
  currency: "USD",
  note: "Synthetic order receipt",
  source: "ebay-seller",
  observed_at: "2000-01-01T00:00:00Z",
};
const csv = (changes = {}) => Papa.unparse([{ ...row, ...changes }]);
const [parsed] = parseSellerOutcomeCsv(csv(), "PokeBash");
assert.equal(
  parsed.source,
  "reviewed-manual",
  "CSV cannot claim provider-verified provenance",
);
assert.equal(parsed.itemId, "090000000001");
assert.equal(parsed.seller, "pokebash");
assert.equal(
  "observedAt" in parsed,
  false,
  "CSV cannot backdate knowledge time",
);
for (const changes of [
  { quantity: "2" },
  { price: "-1" },
  { price: "1.001" },
  { currency: "" },
  { note: "" },
  { occurred_at: "2026-02-30T12:00:00Z" },
  { occurred_at: "2026-09-01" },
  { kind: "missing" },
  { kind: "cancellation", price: "", currency: "" },
  { kind: "relist", next_item_id: row.item_id, price: "", currency: "" },
])
  assert.throws(() => parseSellerOutcomeCsv(csv(changes), "pokebash"));
assert.throws(() =>
  parseSellerOutcomeCsv(Papa.unparse(Array(51).fill(row)), "pokebash"),
);
const sale = { ...parsed, observedAt: "2026-09-05T12:00:00Z" };
const cancellation = {
  ...sale,
  id: "cancel-1",
  kind: "cancellation" as const,
  relatedSaleId: sale.id,
  price: null,
  occurredAt: "2026-09-02T12:00:00Z",
};
const review = reconcileSellerOutcomes(
  [sale, cancellation, { ...cancellation, occurredAt: "2026-09-03T12:00:00Z" }],
  {
    seller: "pokebash",
    itemIds: new Set([sale.itemId]),
    asOf: sale.observedAt,
  },
);
assert.equal(
  review.sales,
  0,
  "A conflicting cancellation cannot silently restore a sale to usable outcomes",
);
assert.deepEqual(review.heldSaleIds, [sale.id]);
console.log(
  "PASS reviewed outcome CSV bounds, exact IDs, chronology, source isolation and conservative conflicting cancellations",
);
