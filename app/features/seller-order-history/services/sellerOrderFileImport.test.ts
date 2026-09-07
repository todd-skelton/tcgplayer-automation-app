import assert from "node:assert/strict";
import { parseSellerOrderCsv } from "./sellerOrderFileImport.server";

const csv = `Order Number,Order Time,Status,SKU ID,Quantity,Gross Item Proceeds USD,Currency,Product ID
OLD-1,2026-01-10T12:00:00-06:00,Completed - Paid,100,1,1.10,USD,10
OLD-1,2026-01-10T12:00:00-06:00,Completed - Paid,100,2,2.20,USD,10`;
const parsed = parseSellerOrderCsv("seller-a", csv, "2026-09-07T00:00:00Z");
assert.equal(parsed.length, 1);
assert.equal(parsed[0]?.orderTime, "2026-01-10T18:00:00.000Z");
assert.equal(parsed[0]?.grossItemProceeds, 3.3);
assert.equal(parsed[0]?.lines.length, 2);

assert.throws(
  () => parseSellerOrderCsv("seller-a", csv.replace("-06:00", "")),
  /UTC offset/,
);
assert.throws(
  () => parseSellerOrderCsv("seller-a", csv.replace(",USD,", ",CAD,")),
  /Currency must be USD/,
);
assert.throws(
  () => parseSellerOrderCsv("seller-a", csv.replace("1.10", "1.101")),
  /two decimal places/,
);
assert.throws(
  () => parseSellerOrderCsv("seller-a", csv.replace("1.10", "-0.10")),
  /cannot be negative/,
);
const contradictoryRows = `Order Number,Order Time,Status,SKU ID,Quantity,Gross Item Proceeds USD,Order Channel
OLD-2,2026-01-10T12:00:00Z,Completed - Paid,100,1,1.00,TcgMarketplace
OLD-2,2026-01-10T12:00:00Z,Completed - Paid,101,1,1.00,`;
for (const rows of [contradictoryRows, contradictoryRows.split("\n").slice(0, 1).concat(
  contradictoryRows.split("\n").slice(1).reverse(),
).join("\n")]) {
  assert.throws(() => parseSellerOrderCsv("seller-a", rows), /disagree on order-level fields/);
}
console.log("PASS seller order CSV import validates offsets, USD, decimals, and duplicate SKU rows");
