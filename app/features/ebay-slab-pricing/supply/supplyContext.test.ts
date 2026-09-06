import assert from "node:assert/strict";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { SupplyEvidence } from "../evidence/slabEvidence";
import {
  describeSupply,
  compareSupplyScans,
  reconcileSellerOutcomes,
  type SupplyScan,
  type SellerOutcome,
} from "./supplyContext";
import { supplyVersion } from "./supplyObservations.server";
import fixture from "./fixtures/historical-supply.json";
const identity: StoredSlabIdentity = {
  id: "00000000-0000-0000-0000-000000000001",
  grader: "PSA",
  certificateNumber: "test",
  candidate: null,
  identity: {
    card: {
      name: "Slaking",
      game: "Pokemon",
      set: "Detective Pikachu",
      cardNumber: "18",
      year: "2019",
      language: "English",
      edition: "Unlimited",
      finish: "Holo",
      stamp: "None",
    },
    grading: {
      grader: "PSA",
      encoding: "9",
      number: 9,
      label: "PSA 9",
      qualifier: null,
      autograph: null,
    },
    providerAsset: null,
  },
  status: "confirmed",
  reviewReasons: [],
  valuationGroupKey: "a".repeat(64),
  revision: 1,
  decisionSource: "manual",
  decisionNote: "Fixture",
  updatedAt: new Date(fixture.capturedAt),
};
const slaking = fixture.cases.find((c) => c.query.startsWith("Slaking"))!;
const scan: SupplyScan = {
  id: "scan-1",
  sourceKey: "test-scope",
  capturedAt: fixture.capturedAt,
  complete: false,
  reportedCount: slaking.listings.length,
  listings: slaking.listings as SupplyEvidence[],
};
const now = new Date(Date.parse(fixture.capturedAt) + 60000).toISOString();
const context = describeSupply(
  scan,
  identity,
  new Set(fixture.knownOwnItemIds),
  now,
);
const old = context.rows.find((r) => r.listing.providerId === "114879934598")!;
assert.ok(old.listingAgeDays! > 1800);
assert.equal(context.saleProbability, null);
assert.equal(context.expectedDaysToSell, null);
assert.equal(context.pricePolicyChanged, false);
assert.equal(
  context.rows.find((r) => r.listing.providerId === "178450771283")!
    .deliveredAsk,
  null,
  "An auction bid cannot be displayed as a delivered ask",
);
assert.ok(
  context.rows
    .find((r) => r.listing.providerId === "178450771283")!
    .reasons.includes("auction-bid-is-not-an-ask"),
);
assert.ok(
  context.rows
    .find((r) => r.listing.providerId === "397333090254")!
    .reasons.includes("own-current-listing"),
);
const stale = describeSupply(
  scan,
  identity,
  new Set(),
  new Date(Date.parse(now) + 86400000).toISOString(),
);
assert.equal(stale.stale, true);
assert.equal(stale.equivalentListings, 0);
assert.equal(stale.potentialListings, 0);
assert.equal(describeSupply(scan, identity, new Set(), now, true).stale, true);
const krabby = fixture.cases.find((c) => c.query.startsWith("Krabby"))!;
assert.ok(
  krabby.listings.find((r) => r.providerId === "235306261329")!.price.amount >
    krabby.listings.find((r) => r.providerId === "397285478425")!.price.amount,
  "Lower grade can have a higher ask; never impose a monotonic ladder",
);
const espathra = fixture.cases.find((c) => c.query.startsWith("Espathra"))!;
assert.equal(
  describeSupply(
    { ...scan, listings: espathra.listings as SupplyEvidence[] },
    identity,
    new Set(),
    now,
  ).saleProbability,
  null,
  "Active supply does not create a rate for a no-sale target",
);
const changed: SupplyScan = {
  ...scan,
  id: "scan-2",
  capturedAt: now,
  listings: [
    {
      ...scan.listings[0],
      price: { amount: 90, currency: "USD" },
      quantity: 0,
      state: "ENDED",
    },
  ],
};
const delta = compareSupplyScans(scan, changed);
assert.equal(delta.continuousExposureKnown, false);
assert.ok(delta.changes.every((c) => c.saleConfirmed === false));
assert.ok(delta.changes.some((c) => c.kind === "observed-price-change"));
assert.ok(delta.changes.some((c) => c.kind === "observed-availability-change"));
assert.ok(delta.changes.some((c) => c.kind === "observed-quantity-change"));
assert.ok(delta.changes.some((c) => c.kind === "not-observed-in-partial-scan"));
assert.ok(
  compareSupplyScans(scan, { ...changed, complete: true }).changes.some(
    (c) => c.kind === "not-in-complete-scan",
  ),
);
assert.throws(() =>
  compareSupplyScans(scan, { ...changed, sourceKey: "another-scope" }),
);
assert.throws(() =>
  compareSupplyScans(scan, { ...changed, capturedAt: "invalid" }),
);
assert.equal(
  supplyVersion(scan.listings[0]).hash,
  supplyVersion(
    Object.fromEntries(
      Object.entries(scan.listings[0]).reverse(),
    ) as SupplyEvidence,
  ).hash,
);
const relisted: SupplyScan = {
  ...changed,
  id: "scan-3",
  capturedAt: new Date(Date.parse(now) + 60000).toISOString(),
  listings: [{ ...scan.listings[0], providerId: "999999999999" }],
};
assert.ok(
  compareSupplyScans(changed, relisted).changes.every((c) => !c.saleConfirmed),
);
const sale: SellerOutcome = {
  id: "order-line-sale",
  seller: "pokebash",
  itemId: "397333090254",
  occurredAt: "2026-09-01T12:00:00Z",
  observedAt: "2026-09-02T12:00:00Z",
  kind: "sale",
  nextItemId: null,
  relatedSaleId: null,
  quantity: 1,
  price: { amount: 20, currency: "USD" },
  source: "ebay-seller",
  note: null,
};
const options = {
  seller: "pokebash",
  itemIds: new Set([sale.itemId]),
  asOf: "2026-09-05T23:00:00Z",
};
const once = reconcileSellerOutcomes(
  [sale, { ...sale, observedAt: "2026-09-03T00:00:00Z" }],
  options,
);
assert.equal(once.sales, 1);
const cancellation: SellerOutcome = {
  ...sale,
  id: "order-line-cancel",
  kind: "cancellation",
  relatedSaleId: sale.id,
  occurredAt: "2026-09-03T12:00:00Z",
  observedAt: "2026-09-04T12:00:00Z",
  price: null,
};
const relist: SellerOutcome = {
  ...cancellation,
  id: "verified-relist",
  kind: "relist",
  nextItemId: "999999999999",
  relatedSaleId: null,
};
const outcomes = reconcileSellerOutcomes([sale, cancellation, relist], options);
assert.equal(outcomes.sales, 0);
assert.equal(outcomes.cancellations, 1);
assert.equal(outcomes.relists, 1);
assert.equal(outcomes.saleProbability, null);
assert.equal(outcomes.exposureValidated, false);
assert.deepEqual(
  reconcileSellerOutcomes(
    [
      sale,
      {
        ...sale,
        price: { amount: 999, currency: "USD" },
        observedAt: "2027-01-01T00:00:00Z",
      },
    ],
    options,
  ),
  reconcileSellerOutcomes([sale], options),
);
assert.equal(
  reconcileSellerOutcomes(
    [
      { ...sale, seller: "another-seller" },
      { ...sale, id: "manual", source: "reviewed-manual", note: null },
      { ...sale, id: "invalid-capture", observedAt: "invalid" },
    ],
    options,
  ).known.length,
  0,
);
console.log(
  "PASS old Slaking asks, nonmonotonic Krabby asks, no-sale Espathra, own/bid exclusions, partial scans, price/availability changes, verified cancellation/relist outcomes and no inferred sale rate",
);
