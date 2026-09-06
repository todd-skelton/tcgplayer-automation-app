import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import Papa from "papaparse";
import { getPool } from "~/core/db/database.server";
import { parseInventoryCsv } from "../inventory/slabInventoryCsv.server";
import { reconcileInventory } from "../inventory/slabInventory.server";
import {
  importSellerOutcomeCsv,
  readSellerOutcomes,
} from "./sellerOutcomes.server";
import { action } from "../routes/api.slab-outcomes.server";
dotenv.config({
  path: [".env.development.local", ".env.local", ".env.development", ".env"],
  quiet: true,
});
const url = new URL(
  process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation",
);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.port === "5433" &&
    url.pathname === "/tcgplayer_automation",
);
const schema = `slab_outcome_test_${randomUUID().replaceAll("-", "")}`,
  admin = new pg.Client({ connectionString: url.toString() });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool(),
  originalFetch = globalThis.fetch;
let remote = 0;
globalThis.fetch = async () => {
  remote++;
  throw new Error("Outcomes must use only saved observations");
};
try {
  for (const migration of [
    "025_add_slab_identities.sql",
    "026_add_slab_inventory.sql",
    "034_add_slab_seller_outcomes.sql",
  ])
    await db.query(await readFile(`db/migrations/${migration}`, "utf8"));
  const seller = "outcome-fixture",
    itemId = "900000000066",
    otherItem = "900000000067";
  await reconcileInventory(
    parseInventoryCsv(
      Papa.unparse(
        [itemId, otherItem].map((item_id) => ({
          item_id,
          title: "Synthetic outcome listing",
          price: 100,
          currency: "USD",
          quantity: 1,
          state: "active",
          format: "fixed-price",
        })),
      ),
      seller,
    ),
    0,
  );
  const inventoryBefore = (
    await db.query(
      "SELECT to_jsonb(i) AS row FROM slab_inventory i ORDER BY item_id",
    )
  ).rows;
  const sale = {
    event_id: "sale-1",
    item_id: itemId,
    kind: "sale",
    occurred_at: "2026-09-01T12:00:00Z",
    quantity: "1",
    price: "125",
    currency: "USD",
    note: "Synthetic sale receipt",
    related_sale_id: "",
    next_item_id: "",
  };
  const csv = (rows = [sale]) => Papa.unparse(rows);
  const [first, duplicate] = await Promise.all([
    importSellerOutcomeCsv(csv(), seller),
    importSellerOutcomeCsv(csv(), seller),
  ]);
  assert.equal(first.inserted + duplicate.inserted, 1);
  let review = await readSellerOutcomes(seller, itemId);
  assert.equal(review.summary.sales, 1);
  assert.equal(review.observations.length, 1);
  const observed = review.observations[0].observedAt;
  assert.equal(
    (
      await readSellerOutcomes(
        seller,
        itemId,
        new Date(Date.parse(observed) - 1).toISOString(),
      )
    ).observations.length,
    0,
  );
  assert.equal(
    (await readSellerOutcomes(seller, itemId, observed)).summary.sales,
    1,
  );
  assert.equal((await importSellerOutcomeCsv(csv(), seller)).inserted, 0);
  assert.equal(
    (await readSellerOutcomes(seller, itemId)).observations[0].observedAt,
    observed,
  );
  const cancellation = {
    ...sale,
    event_id: "cancel-1",
    kind: "cancellation",
    occurred_at: "2026-09-02T12:00:00Z",
    price: "",
    currency: "",
    related_sale_id: sale.event_id,
  };
  const relist = {
    ...sale,
    event_id: "relist-1",
    kind: "relist",
    occurred_at: "2026-09-03T12:00:00Z",
    price: "",
    currency: "",
    next_item_id: otherItem,
  };
  assert.equal(
    (await importSellerOutcomeCsv(csv([cancellation, relist]), seller))
      .inserted,
    2,
  );
  review = await readSellerOutcomes(seller, itemId);
  assert.equal(review.summary.sales, 0);
  assert.equal(review.summary.cancellations, 1);
  assert.equal(review.summary.relists, 1);
  assert.equal(review.saleProbability, null);
  assert.equal(review.exposureValidated, false);
  await importSellerOutcomeCsv(
    csv([{ ...cancellation, occurred_at: "2026-09-04T12:00:00Z" }]),
    seller,
  );
  review = await readSellerOutcomes(seller, itemId);
  assert.ok(review.summary.unresolved.includes(cancellation.event_id));
  assert.deepEqual(review.summary.heldSaleIds, [sale.event_id]);
  assert.equal(review.summary.sales, 0);
  await importSellerOutcomeCsv(csv([{ ...sale, item_id: otherItem }]), seller);
  for (const id of [itemId, otherItem]) {
    const conflict = await readSellerOutcomes(seller, id);
    assert.ok(conflict.summary.unresolved.includes(sale.event_id));
    assert.equal(conflict.summary.sales, 0);
  }
  assert.equal(
    (await readSellerOutcomes("another-seller", itemId)).observations.length,
    0,
  );
  const countBefore = (
    await db.query("SELECT count(*)::int AS n FROM slab_seller_outcomes")
  ).rows[0].n;
  for (const rows of [
    [{ ...sale, event_id: "future", occurred_at: "2999-01-01T00:00:00Z" }],
    [
      { ...sale, event_id: "valid" },
      { ...sale, event_id: "unknown", item_id: "999999999999" },
    ],
  ])
    await assert.rejects(() => importSellerOutcomeCsv(csv(rows), seller));
  await assert.rejects(() => importSellerOutcomeCsv(csv(), "another-seller"));
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM slab_seller_outcomes"))
      .rows[0].n,
    countBefore,
    "Invalid batches cannot partially persist",
  );
  for (const [method, origin, expected] of [
    ["GET", "http://localhost", 405],
    ["POST", "https://foreign.example", 403],
  ] as const) {
    const result = await action({
      request: new Request("http://localhost/api/slab-outcomes", {
        method,
        headers: { Origin: origin },
      }),
    });
    assert.equal(result.init?.status, expected);
  }
  const started = performance.now();
  for (let offset = 0; offset < 250; offset += 50)
    await importSellerOutcomeCsv(
      csv(
        Array.from({ length: 50 }, (_, n) => ({
          ...sale,
          event_id: `bulk-${offset + n}`,
          item_id: otherItem,
        })),
      ),
      seller,
    );
  await assert.rejects(() => readSellerOutcomes(seller, otherItem), /250/);
  console.log(
    `250-observation append fixture: ${(performance.now() - started).toFixed(1)} ms; oversized review abstains`,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT to_jsonb(i) AS row FROM slab_inventory i ORDER BY item_id",
      )
    ).rows,
    inventoryBefore,
    "Recording an outcome does not mutate inventory, quantity or price",
  );
  assert.equal(remote, 0);
  console.log(
    "PASS immutable outcome imports, concurrent retries, first-observation time, cancellations/relists, cross-item conflicts, seller isolation, atomic invalid batches, request gates and bounded review without remote calls",
  );
} finally {
  globalThis.fetch = originalFetch;
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
