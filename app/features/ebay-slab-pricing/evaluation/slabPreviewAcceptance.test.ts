import assert from "node:assert/strict";
import Papa from "papaparse";
import fixture from "./fixtures/pokebash-preview-sample.json";
import { parseInventoryCsv } from "../inventory/slabInventoryCsv.server";
export const acceptanceCsv = Papa.unparse(
  fixture.listings.map((r) => ({
    item_id: r.itemId,
    title: r.title,
    price: r.askingPriceUsd,
    currency: "USD",
    quantity: 1,
    state: "active",
    format: "fixed-price",
  })),
); // Quantity/format are placeholders for import testing, not facts learned from the historical titles.
const imported = parseInventoryCsv(acceptanceCsv, "acceptance-fixture");
assert.equal(imported.listings.length, 50);
assert.equal(new Set(imported.listings.map((r) => r.itemId)).size, 50);
assert.equal(new Set(fixture.listings.map((r) => r.researchQuery)).size, 49);
assert.equal(
  fixture.listings[4].researchQuery,
  fixture.listings[39].researchQuery,
);
assert.notEqual(imported.listings[4].itemId, imported.listings[39].itemId);
assert.ok(
  imported.listings.every(
    (r) =>
      r.certificate === null &&
      r.reviewReasons.includes("certificate-required"),
  ),
);
assert.equal(imported.completeActiveInventory, false);
for (const marker of [
  /PSA/,
  /CGC/,
  /SGC/,
  /Japanese|Japan/,
  /1999/,
  /One Piece/i,
])
  assert.ok(
    fixture.listings.some((r) => marker.test(r.title)),
    String(marker),
  );
assert.equal(fixture.listings.filter((r) => r.visibleSoldRows === 0).length, 8);
console.log(
  "PASS 50 historical listings remain reviewable, two Zapdos records share research without sharing listing identity, and unsupported cohorts remain visible",
);
