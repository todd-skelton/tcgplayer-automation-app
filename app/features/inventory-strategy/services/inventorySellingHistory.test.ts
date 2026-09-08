import assert from "node:assert/strict";
import type { SellingHistorySourceEvidence } from "../types/inventorySellingHistory";
import { buildInventorySellingHistoryReport } from "./inventorySellingHistory";

const day = (index: number) =>
  new Date(Date.UTC(2026, 0, 1 + index)).toISOString();

function evidence(
  overrides: Partial<SellingHistorySourceEvidence> = {},
): SellingHistorySourceEvidence {
  return {
    sellerKey: "seller",
    scope: { windowDays: 180, productLine: null },
    availableProductLines: ["Magic", "Pokemon"],
    analysisFrom: day(-700),
    inventoryObservedAt: day(30),
    orderCoverage: {
      sellerKey: "seller",
      source: "tcgplayer_api",
      status: "complete",
      completedAt: day(30),
      ordersObserved: 3,
      detailsRecorded: 3,
      gaps: [],
    },
    episodes: [],
    episodeCount: 0,
    outcomes: [],
    outcomeCount: 0,
    projection: { pendingQuantity: 0, heldQuantity: 0, affectedSkus: [] },
    openingUnknownQuantity: 7,
    legacyUnlinked: { quantity: 0, forecastQuantity: 0 },
    olderPublicationQuantity: 0,
    awaitingCutoffQuantity: 0,
    unresolvedRemoval: { quantity: 0, affectedSkus: [] },
    ...overrides,
  };
}

const episodes = [
  {
    episodeKey: "receipt:1",
    receiptId: 1,
    sku: 101,
    productLine: "Pokemon",
    productName: "First",
    kind: "confirmed_publication" as const,
    quantity: 3,
    listedAt: day(0),
    forecastEvidence: null,
    forecastEvidenceProvenance: "unknown" as const,
  },
  {
    episodeKey: "receipt:2",
    receiptId: 2,
    sku: 101,
    productLine: "Pokemon",
    productName: "First",
    kind: "confirmed_publication" as const,
    quantity: 2,
    listedAt: day(4),
    forecastEvidence: null,
    forecastEvidenceProvenance: "unknown" as const,
  },
  {
    episodeKey: "receipt:3",
    receiptId: 3,
    sku: 202,
    productLine: "Magic",
    productName: "Mature",
    kind: "confirmed_publication" as const,
    quantity: 10,
    listedAt: day(0),
    forecastEvidence: null,
    forecastEvidenceProvenance: "unknown" as const,
  },
  {
    episodeKey: "receipt:4",
    receiptId: 4,
    sku: 303,
    productLine: "Magic",
    productName: "Young",
    kind: "confirmed_publication" as const,
    quantity: 10,
    listedAt: day(25),
    forecastEvidence: null,
    forecastEvidenceProvenance: "unknown" as const,
  },
];
const outcomes = [
  { episodeKey: "receipt:1", kind: "sale" as const, quantity: 3, happenedAt: day(5), orderNumber: "A", orderLineId: "1", source: "seller_order" as const },
  { episodeKey: "receipt:2", kind: "sale" as const, quantity: 1, happenedAt: day(5), orderNumber: "A", orderLineId: "1", source: "seller_order" as const },
  { episodeKey: "receipt:3", kind: "sale" as const, quantity: 2, happenedAt: day(10), orderNumber: "B", orderLineId: "2", source: "seller_order" as const },
];

const report = buildInventorySellingHistoryReport(
  evidence({ episodes, episodeCount: episodes.length, outcomes, outcomeCount: outcomes.length }),
);
assert.equal(report.status, "ready");
if (report.status === "ready") {
  const pokemon = report.productLines.find((row) => row.productLine === "Pokemon")!;
  assert.equal(pokemon.soldWithKnownListedDateQuantity, 4);
  assert.equal(pokemon.soldOnlyAverageDays, 4);
  assert.equal(pokemon.remainingWithKnownAgeQuantity, 1);
  const magic30 = report.productLines
    .find((row) => row.productLine === "Magic")!
    .sellThrough.find((row) => row.days === 30)!;
  assert.deepEqual(magic30, {
    days: 30,
    eligibleQuantity: 10,
    soldQuantity: 2,
    rate: 0.2,
    status: "exact",
  });
  assert.equal(report.overall.medianDaysToSale, null);
  assert.equal(report.overall.p90DaysToSale, null);
  assert.equal(report.coverage.openingUnknownQuantity, 7);
}

const unsettled = buildInventorySellingHistoryReport(
  evidence({
    episodes: [episodes[2]],
    episodeCount: 1,
    projection: { pendingQuantity: 2, heldQuantity: 0, affectedSkus: [202] },
  }),
);
assert.equal(unsettled.status, "ready");
if (unsettled.status === "ready") {
  assert.equal(unsettled.overall.medianDaysToSale, null);
  assert.equal(unsettled.overall.percentileStatus, "unsettled_outcomes");
  assert.deepEqual(
    unsettled.overall.sellThrough.find((row) => row.days === 30),
    {
      days: 30,
      eligibleQuantity: 10,
      soldQuantity: 0,
      rate: null,
      status: "unsettled_outcomes",
    },
  );
}

const removed = buildInventorySellingHistoryReport(
  evidence({
    episodes: [episodes[2]],
    episodeCount: 1,
    outcomes: [{
      episodeKey: "receipt:3",
      kind: "removed",
      quantity: 1,
      happenedAt: day(15),
      orderNumber: "C",
      orderLineId: "3",
      source: "cancellation",
    }],
    outcomeCount: 1,
  }),
);
assert.equal(removed.status, "ready");
if (removed.status === "ready") {
  assert.equal(removed.overall.percentileStatus, "competing_removals");
  assert.equal(removed.overall.medianDaysToSale, null);
  assert.equal(
    removed.overall.sellThrough.find((row) => row.days === 30)?.eligibleQuantity,
    10,
  );
}

const futurePublication = buildInventorySellingHistoryReport(
  evidence({
    episodes: [{ ...episodes[2], listedAt: day(31) }],
    episodeCount: 1,
    awaitingCutoffQuantity: 10,
  }),
);
assert.equal(futurePublication.status, "ready");
if (futurePublication.status === "ready") {
  assert.equal(futurePublication.overall.cohortQuantity, 0);
  assert.equal(futurePublication.coverage.awaitingCutoffQuantity, 10);
}

const overBound = buildInventorySellingHistoryReport(
  evidence({
    scope: { windowDays: 730, productLine: null },
    episodeCount: 20_001,
  }),
);
assert.equal(overBound.status, "unavailable");
if (overBound.status === "unavailable") {
  assert.equal(overBound.reason, "history_bounds_exceeded");
  assert.deepEqual(overBound.scope, { windowDays: 730, productLine: null });
  assert.deepEqual(overBound.availableProductLines, ["Magic", "Pokemon"]);
}
const narrowed = buildInventorySellingHistoryReport(
  evidence({ scope: { windowDays: 180, productLine: "Magic" } }),
);
assert.equal(narrowed.status, "ready");

const returned = buildInventorySellingHistoryReport(
  evidence({
    episodes: [
      episodes[0],
      {
        ...episodes[1],
        episodeKey: "restock:1:receipt:1",
        kind: "physical_restock",
        quantity: 1,
        listedAt: null,
      },
    ],
    episodeCount: 2,
    outcomes: [
      {
        ...outcomes[0],
        quantity: 1,
        kind: "removed",
        source: "cancellation",
      },
    ],
    outcomeCount: 1,
  }),
);
assert.equal(returned.status, "ready");
if (returned.status === "ready") {
  assert.equal(returned.overall.unknownListedDateQuantity, 1);
  assert.equal(returned.overall.percentileStatus, "competing_removals");
  assert.equal(returned.overall.medianDaysToSale, null);
}

assert.equal(
  buildInventorySellingHistoryReport(
    evidence({ orderCoverage: { ...evidence().orderCoverage, status: "incomplete" } }),
  ).status,
  "unavailable",
);
assert.equal(
  buildInventorySellingHistoryReport(evidence({ episodeCount: 1 })).status,
  "unavailable",
);

console.log("PASS inventory selling history preserves cohorts, censoring, and coverage");
