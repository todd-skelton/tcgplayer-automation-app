// Opt-in PostgreSQL integration test; real tables in a disposable local schema.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { getPool } from "~/core/db/database.server";
import { slabIdentityStore } from "../identity/slabIdentities.server";
import { parseAltCertificate } from "../identity/altIdentityProvider.server";
import { valuationGroupKey } from "../identity/slabIdentityService.server";
import fixture from "../identity/fixtures/alt-cert-110185364.json";
import {
  reconcileInventory,
  getInventory,
  assignInventoryIdentity,
  inventoryRevision,
} from "./slabInventory.server";
import { listingFixture } from "./slabInventory.test";
import type { InventoryImport } from "./slabInventory";
import { action } from "../routes/api.slab-inventory.server";

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
const admin = new pg.Client({ connectionString: url.toString() });
const schema = `slab_inventory_test_${randomUUID().replaceAll("-", "")}`;
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const db = getPool();
try {
  for (const file of [
    "025_add_slab_identities.sql",
    "026_add_slab_inventory.sql",
  ])
    await db.query(await readFile(`db/migrations/${file}`, "utf8"));
  const candidate = parseAltCertificate(JSON.stringify(fixture))!;
  const cert = listingFixture.certificate!;
  const identity = {
    ...candidate.identity,
    card: { ...candidate.identity.card, name: "Galarian Zapdos" },
    grading: {
      ...candidate.identity.grading,
      number: 8,
      encoding: "8.0",
      label: "NM-MT 8",
    },
  };
  const saved = await slabIdentityStore.saveCandidate(cert, null, []);
  const confirmed = (await slabIdentityStore.confirm(
    cert,
    saved.revision,
    identity,
    valuationGroupKey(identity),
    "Reviewed test identity",
  ))!;
  const otherCert = { ...cert, certificateNumber: "00234567" };
  const otherSaved = await slabIdentityStore.saveCandidate(otherCert, null, []);
  await slabIdentityStore.confirm(
    otherCert,
    otherSaved.revision,
    identity,
    valuationGroupKey(identity),
    "Separate physical slab, same card and grade",
  );
  const input: InventoryImport = {
    seller: "pokebash",
    source: "ebay",
    completeActiveInventory: true,
    observedAt: new Date().toISOString(),
    listings: [
      listingFixture,
      { ...listingFixture, itemId: "397774081600", certificate: otherCert },
    ],
  };
  await reconcileInventory(input, 0);
  let page = await getInventory("pokebash");
  assert.equal(page.items.length, 2);
  assert.equal(
    new Set(page.items.map((row) => row.identity?.valuationGroupKey)).size,
    1,
  );
  assert.equal(new Set(page.items.map((row) => row.id)).size, 2);
  assert.equal(page.items[0].revision, 1);
  await reconcileInventory(input, 1);
  page = await getInventory("pokebash");
  assert.equal(
    page.items[0].revision,
    1,
    "identical re-import leaves publication reference current",
  );
  const first = page.items.find((row) => row.itemId === listingFixture.itemId)!;
  await assignInventoryIdentity(
    "pokebash",
    first.id,
    first.revision,
    confirmed.id,
    "Manual certificate correction",
  );
  const changed = {
    ...listingFixture,
    title: "Renamed Zapdos",
    quantity: 0,
    state: "sold" as const,
    certificate: otherCert,
  };
  await reconcileInventory(
    {
      ...input,
      source: "csv",
      completeActiveInventory: false,
      listings: [changed],
    },
    2,
  );
  page = await getInventory("pokebash");
  const updated = page.items.find((row) => row.id === first.id)!;
  assert.equal(updated.identityId, confirmed.id);
  assert.equal(updated.identitySource, "manual");
  assert.equal(updated.identityNote, "Manual certificate correction");
  assert.equal(updated.state, "sold");
  assert.ok(updated.revision > first.revision);
  assert.ok(
    updated.reviewReasons.includes(
      "listing-certificate-conflicts-with-manual-identity",
    ),
  );
  assert.equal(
    page.items.find((row) => row.id !== first.id)!.state,
    "active",
    "partial import cannot retire unseen stock",
  );
  await reconcileInventory({ ...input, listings: [] }, 3);
  page = await getInventory("pokebash");
  assert.equal(page.items.find((row) => row.id !== first.id)!.state, "missing");
  assert.equal(page.items.find((row) => row.id === first.id)!.state, "sold");
  await assert.rejects(reconcileInventory(input, 3), /changed/);
  const parallel = await Promise.allSettled([
    reconcileInventory(input, 4),
    reconcileInventory(input, 4),
  ]);
  assert.equal(
    parallel.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(await inventoryRevision("pokebash"), 5);
  await reconcileInventory({ ...input, seller: "another-seller" }, 0);
  assert.equal((await getInventory("another-seller")).items.length, 2);
  await assert.rejects(
    assignInventoryIdentity(
      "another-seller",
      first.id,
      1,
      confirmed.id,
      "Wrong seller",
    ),
  );
  const singlePage = await getInventory("pokebash", "", 1);
  assert.ok(singlePage.next);
  assert.equal(
    (await getInventory("pokebash", singlePage.next!, 1)).items.length,
    1,
  );
  await reconcileInventory(
    {
      ...input,
      listings: [listingFixture, { ...listingFixture, itemId: "397774081600" }],
    },
    5,
  );
  assert.ok(
    (await getInventory("pokebash")).items.every(
      (row) => row.duplicateCertificate,
    ),
  );
  const summary = {
    ...input,
    listings: [
      {
        ...listingFixture,
        certificate: null,
        expected: {},
        specifics: {},
        reviewReasons: ["listing-details-required"],
      },
    ],
  };
  await reconcileInventory(summary, 6);
  const afterSummary = (await getInventory("pokebash")).items.find(
    (row) => row.itemId === listingFixture.itemId,
  )!;
  assert.deepEqual(
    afterSummary.snapshot.certificate,
    listingFixture.certificate,
    "summary cannot erase previously read certificate details",
  );
  assert.ok(
    afterSummary.reviewReasons.includes("listing-details-required"),
    "retained metadata is visibly awaiting a fresh detail read",
  );
  await reconcileInventory(summary, 7);
  assert.equal(
    (await getInventory("pokebash")).items.find(
      (row) => row.id === afterSummary.id,
    )!.revision,
    afterSummary.revision,
  );
  const routeRequest = (body: unknown, origin = "http://localhost") =>
    new Request("http://localhost/api/slab-inventory", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await action({ request: routeRequest({}, "http://elsewhere") })).init
      ?.status,
    403,
  );
  assert.equal(
    (await action({ request: routeRequest(null) })).init?.status,
    400,
  );
  assert.equal(
    (
      await action({
        request: routeRequest({
          seller: "pokebash",
          revision: 5,
          intent: "import-manual",
          listings: [],
        }),
      })
    ).init?.status,
    409,
  );
  const routeImport = await action({
    request: routeRequest({
      seller: "route-test",
      revision: 0,
      intent: "import-manual",
      listings: [listingFixture],
      completeActiveInventory: true,
    }),
  });
  assert.equal(routeImport.init?.status, 200);
  assert.equal(
    (routeImport.data as { complete: boolean }).complete,
    false,
    "client cannot assert complete coverage",
  );
  const started = performance.now();
  await reconcileInventory(
    {
      ...input,
      seller: "performance-test",
      listings: Array.from({ length: 5000 }, (_, i) => ({
        ...listingFixture,
        itemId: String(397780000000 + i),
        certificate: null,
      })),
    },
    0,
  );
  const importedMs = performance.now() - started;
  const readStarted = performance.now();
  assert.equal(
    (await getInventory("performance-test", "", 200)).items.length,
    200,
  );
  console.log(
    `Slab inventory local measurement: 5,000-row import ${Math.round(importedMs)}ms; 200-row page ${Math.round(performance.now() - readStarted)}ms.`,
  );
  console.log(
    "Slab inventory integration: idempotence, grouping, partial/complete imports, corrections, conflicts, account isolation and pagination passed.",
  );
} finally {
  await db.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
