import assert from "node:assert/strict";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import type { SaleEvidence, SupplyEvidence } from "../evidence/slabEvidence";
import {
  screenComparableSale,
  screenCompetitorSupply,
  type CompDecision,
} from "./screenComparables";
import { gradeLabelKey, titleFacts } from "./compIdentity";
import { normalizeSalePrice } from "./salePrice";
import { reconcileSaleEvents, type SaleReference } from "./compEvents";
import shared from "./fixtures/shared-ponyta-sales.json";

export const compTarget: StoredSlabIdentity = {
  id: "00000000-0000-0000-0000-000000000001",
  grader: "PSA",
  certificateNumber: "001234",
  candidate: null,
  identity: {
    card: {
      name: "Goldeen",
      game: "Pokemon",
      set: "Jungle",
      cardNumber: "53/64",
      language: "English",
      year: "1999",
      edition: "1st Edition",
      finish: "Non-Holo",
      stamp: null,
    },
    grading: {
      grader: "PSA",
      number: 9,
      label: "PSA 9",
      encoding: "9.0",
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
  decisionNote: "Verified slab",
  updatedAt: new Date("2026-09-05"),
};
export const compSale: SaleEvidence = {
  provider: "alt",
  providerId: "sale-1",
  assetId: null,
  sourceUrl: "https://www.ebay.com/itm/123456789012",
  sourceReference: "https://www.ebay.com/itm/123456789012",
  sourceItemId: "123456789012",
  venue: "eBay",
  kind: "transaction",
  date: "2026-08-30",
  format: "AUCTION",
  title:
    "1999 Pokemon Jungle 1st Edition Goldeen #53/64 English Non-Holo PSA 9",
  card: compTarget.identity!.card,
  grading: compTarget.identity!.grading,
  certificateNumber: null,
  price: { amount: 100, currency: "USD" },
  convertedPrice: null,
  shipping: { amount: 0, currency: "USD" },
  fees: { amount: 0, currency: "USD" },
  shippingIncluded: false,
  buyerPremiumIncluded: false,
  quantity: 1,
  subjectToChange: false,
  skippedReason: null,
};
export const compReference: SaleReference = {
  revisionId: "00000000-0000-0000-0000-000000000002",
  fetchedAt: "2026-09-05T12:00:00.000Z",
  window: { from: "2026-06-07", to: "2026-09-05" },
  sale: compSale,
};
const screen = (
  sale: SaleEvidence,
  target = compTarget,
  decision?: CompDecision,
) =>
  screenComparableSale({ ...compReference, sale }, target, {
    currency: "USD",
    decision,
  });
assert.equal(screen(compSale).status, "accepted");
assert.equal(
  screen({ ...compSale, grading: { ...compSale.grading, label: "PSA 10" } })
    .status,
  "rejected",
);
assert.equal(
  screen({ ...compSale, grading: { ...compSale.grading, label: "PSA 9 (MK)" } })
    .status,
  "rejected",
);
assert.equal(
  screen(
    { ...compSale, card: { ...compSale.card!, name: "ヒトカゲ" } },
    {
      ...compTarget,
      identity: {
        ...compTarget.identity!,
        card: { ...compTarget.identity!.card, name: "ピカチュウ" },
      },
    },
  ).status,
  "rejected",
);
assert.equal(
  screen({ ...compSale, title: compSale.title!.replace("53/64", "54/64") })
    .status,
  "rejected",
);
assert.equal(
  screen({
    ...compSale,
    title: compSale.title!.replace("Goldeen", "Dark Goldeen"),
  }).status,
  "needs-review",
);
assert.equal(
  screen({ ...compSale, price: { amount: 10000, currency: "USD" } }).status,
  "accepted",
  "no price-proximity or premium outlier exclusion",
);
const spanish = screen({
  ...compSale,
  title: compSale.title!.replace("English", "Spanish"),
});
assert.equal(spanish.status, "rejected");
assert.ok(
  spanish.reasons.some(
    (reason) => reason.field === "language" && reason.actual === "Spanish",
  ),
);
const cgc5 = {
  ...compTarget,
  identity: {
    ...compTarget.identity!,
    grading: {
      ...compTarget.identity!.grading,
      grader: "CGC",
      number: 5,
      encoding: "5",
      label: "CGC Excellent 5",
    },
  },
};
const lowPop = screen(
  {
    ...compSale,
    grading: {
      grader: "UNKNOWN",
      number: null,
      encoding: "unknown",
      label: null,
      qualifier: null,
      autograph: null,
    },
    title: "1999 Goldeen Jungle English CGC 10 Low Pop (5)",
  },
  cgc5,
);
assert.equal(lowPop.status, "rejected");
assert.deepEqual(
  titleFacts("CGC 10 Low Pop (5)").grades.map((grade) => grade.number),
  [10],
);
const cgcGem = {
  ...compTarget,
  identity: {
    ...compTarget.identity!,
    grading: {
      ...cgc5.identity.grading,
      number: 10,
      encoding: "10",
      label: "CGC Gem Mint 10",
    },
  },
};
const cgcUnknown = {
  ...compSale,
  grading: { ...cgcGem.identity.grading, label: "CGC 10" },
  title: "Goldeen CGC 10",
};
assert.equal(
  screen(
    {
      ...compSale,
      grading: cgcGem.identity.grading,
      title: "Goldeen CGC Gem Mint 10",
      extendedTitle: "Goldeen CGC Pristine 10",
    },
    cgcGem,
  ).status,
  "rejected",
);
assert.equal(screen(cgcUnknown, cgcGem).status, "needs-review");
assert.equal(
  screen({ ...cgcUnknown, title: "Sentomaru CGC Pristine 10" }, cgcGem).status,
  "rejected",
);
const pristine = {
  ...cgcGem,
  identity: {
    ...cgcGem.identity,
    grading: { ...cgcGem.identity.grading, label: "CGC Pristine 10" },
  },
};
assert.equal(
  screen(
    {
      ...cgcUnknown,
      title: "Goldeen CGC Pristine 10",
      grading: {
        ...cgcUnknown.grading,
        number: null,
        label: null,
        encoding: "10.5",
      },
    },
    pristine,
  ).status,
  "needs-review",
);
assert.equal(gradeLabelKey("CGC", "CGC 10", 10), null);
const psa1 = {
  ...compTarget,
  identity: {
    ...compTarget.identity!,
    grading: {
      ...compTarget.identity!.grading,
      number: 1,
      encoding: "1.0",
      label: "PSA 1",
    },
  },
};
assert.equal(
  screen(
    {
      ...compSale,
      grading: psa1.identity.grading,
      title: "Goldeen PSA 1 (MK)",
    },
    psa1,
  ).status,
  "rejected",
);
assert.equal(
  screen(
    {
      ...compSale,
      grading: { ...psa1.identity.grading, qualifier: "MK" },
      title: "Goldeen PSA 1 (MK)",
    },
    {
      ...psa1,
      identity: {
        ...psa1.identity,
        grading: {
          ...psa1.identity.grading,
          qualifier: "MK",
          label: "PSA 1 (MK)",
        },
      },
    },
  ).status,
  "accepted",
);
assert.equal(
  screen({ ...compSale, title: "Goldeen PSA 9 two cards bundle" }).status,
  "rejected",
);
assert.equal(
  screen({ ...compSale, title: "Goldeen PSA 9 BGS 9" }).status,
  "rejected",
);
assert.equal(
  screen({ ...compSale, title: "Goldeen PSA 9 cracked slab" }).status,
  "needs-review",
);
assert.equal(
  screen({ ...compSale, card: null }).status,
  "needs-review",
  "matching title/search terms do not establish card identity",
);
assert.equal(screen({ ...compSale, date: null }).status, "needs-review");
assert.equal(
  screen({ ...compSale, date: "2026-02-30" }).status,
  "needs-review",
);
assert.equal(screen({ ...compSale, date: "2020-01-01" }).status, "rejected");
const reviewed: CompDecision = {
  revisionId: compReference.revisionId,
  provider: compSale.provider,
  providerId: compSale.providerId,
  date: compSale.date,
  valuationGroupKey: compTarget.valuationGroupKey!,
  decision: "accept",
  note: "Verified exact card and reported item price",
  itemPrice: { amount: 100, currency: "USD" },
};
assert.equal(
  screen(compSale, compTarget, {
    ...reviewed,
    itemPrice: { amount: 120, currency: "USD" },
  }).price.buyerTotal?.amount,
  120,
);
assert.equal(
  screen(compSale, compTarget, {
    ...reviewed,
    itemPrice: { amount: 120, currency: "EUR" },
  }).status,
  "needs-review",
);
assert.equal(
  screen(
    { ...compSale, card: null, skippedReason: "Potential premium sale" },
    compTarget,
    reviewed,
  ).status,
  "accepted",
);
assert.equal(
  screen({ ...compSale, subjectToChange: true }, compTarget, reviewed).status,
  "needs-review",
);
assert.equal(
  screen({ ...compSale, date: null }, compTarget, { ...reviewed, date: null })
    .status,
  "needs-review",
);
assert.equal(
  screen(compSale, compTarget, { ...reviewed, revisionId: "older-revision" })
    .status,
  "needs-review",
);
assert.equal(
  screen(compSale, compTarget, { ...reviewed, decision: "exclude" }).status,
  "rejected",
);
const aggregate = {
  ...compSale,
  kind: "listing-average" as const,
  quantity: 4,
};
assert.equal(screen(aggregate).status, "needs-review");
assert.equal(
  screen(aggregate, compTarget, reviewed).reference.sale.quantity,
  4,
);
const inclusive = normalizeSalePrice(
  {
    ...compSale,
    price: { amount: 150, currency: "USD" },
    shipping: { amount: 10, currency: "USD" },
    fees: { amount: 20, currency: "USD" },
    shippingIncluded: true,
    buyerPremiumIncluded: true,
  },
  "USD",
);
assert.equal(inclusive.itemOnly?.amount, 120);
assert.equal(inclusive.buyerTotal?.amount, 150);
const unknown = normalizeSalePrice(
  { ...compSale, shipping: null, fees: null, buyerPremiumIncluded: null },
  "USD",
);
assert.equal(unknown.itemOnly, null);
assert.equal(unknown.buyerTotal, null);
assert.equal(unknown.shipping, null);
const foreign = {
  ...compSale,
  price: { amount: 100, currency: "EUR" },
  convertedPrice: { amount: 115, currency: "USD" },
};
assert.equal(normalizeSalePrice(foreign, "USD").itemOnly, null);
assert.equal(
  normalizeSalePrice(foreign, "USD", {
    from: "EUR",
    to: "USD",
    rate: 1.1,
    date: compSale.date!,
    source: "Synthetic dated rate fixture",
  }).itemOnly?.amount,
  110,
);
assert.equal(
  normalizeSalePrice(foreign, "USD", {
    from: "EUR",
    to: "USD",
    rate: 1.1,
    date: "2020-01-01",
    source: "Synthetic dated rate fixture",
  }).itemOnly,
  null,
);
const sharedRefs: SaleReference[] = shared.rows.flatMap((pair) =>
  [pair.alt, pair.ebay].map((sale) => ({
    ...compReference,
    revisionId: sale.provider,
    fetchedAt: shared.observedAt,
    sale: sale as SaleEvidence,
  })),
);
const events = reconcileSaleEvents(sharedRefs);
assert.equal(events.length, 11);
assert.ok(events.every((event) => event.references.length === 2));
assert.deepEqual(
  events.map((event) => event.reportedPrice?.amount).sort((a, b) => a! - b!),
  shared.rows.map((pair) => pair.ebay.price.amount).sort((a, b) => a - b),
);
assert.equal(
  events.filter((event) =>
    event.references.some((ref) => ref.sale.format === "BEST_OFFER"),
  ).length,
  2,
);
assert.equal(
  events.find(
    (event) => event.representative.sale.sourceItemId === "127943558744",
  )?.reportedPrice?.amount,
  160,
);
assert.ok(
  events
    .find((event) => event.representative.sale.sourceItemId === "127943558744")
    ?.reasons.includes("provider-conversion-disagrees-with-reported-price"),
);
assert.equal(
  normalizeSalePrice(
    shared.rows.find((pair) => pair.ebay.sourceItemId === "127943558744")!
      .alt as SaleEvidence,
    "USD",
  ).reported,
  null,
);
assert.equal(reconcileSaleEvents([...sharedRefs, ...sharedRefs]).length, 11);
const repeat = sharedRefs.slice(0, 2).map((ref) => ({
  ...ref,
  sale: {
    ...ref.sale,
    date: "2026-08-31",
    providerId:
      ref.sale.provider === "alt" ? "second-transaction" : ref.sale.providerId,
  },
}));
assert.equal(
  reconcileSaleEvents([...sharedRefs.slice(0, 2), ...repeat]).length,
  2,
  "repeat sales under one listing ID survive",
);
const grouped = reconcileSaleEvents([
  sharedRefs[0],
  { ...sharedRefs[1], sale: { ...sharedRefs[1].sale, quantity: 3 } },
]);
assert.equal(grouped.length, 2);
assert.ok(
  grouped.some((event) =>
    event.reasons.includes("aggregate-may-overlap-individual-sales"),
  ),
);
const supply: SupplyEvidence = {
  provider: "ebayResearch",
  providerId: "123456789012",
  assetId: null,
  venue: "eBay",
  sourceUrl: compSale.sourceUrl,
  format: "Fixed price",
  state: "active",
  price: { amount: 100, currency: "USD" },
  priceKind: "ask",
  shipping: null,
  quantity: null,
  startedAt: null,
  endsAt: null,
  items: [],
};
const supplyOptions = {
  ownEbayItemIds: new Set([supply.providerId]),
  capturedAt: compReference.fetchedAt,
  now: compReference.fetchedAt,
  maxAgeMs: 900000,
};
assert.equal(screenCompetitorSupply(supply, supplyOptions).status, "excluded");
assert.equal(
  screenCompetitorSupply({ ...supply, providerId: "other" }, supplyOptions)
    .status,
  "candidate",
);
assert.equal(
  screenCompetitorSupply(
    { ...supply, providerId: "other", priceKind: "bid" },
    supplyOptions,
  ).status,
  "needs-review",
);
assert.equal(
  screenCompetitorSupply(
    { ...supply, providerId: "other", state: null },
    supplyOptions,
  ).status,
  "needs-review",
);
assert.equal(
  screenCompetitorSupply(
    { ...supply, providerId: "other" },
    { ...supplyOptions, now: "2026-09-06T12:00:00Z" },
  ).status,
  "needs-review",
);
console.log(
  "PASS strict comp identity, grade labels, price semantics, review revisions, eleven shared sales, Best Offers and own/stale supply",
);
