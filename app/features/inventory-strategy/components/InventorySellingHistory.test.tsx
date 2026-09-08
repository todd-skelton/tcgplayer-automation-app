import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { InventorySellingHistory } from "./InventorySellingHistory";
import type { InventorySellingHistoryReport } from "../types/inventorySellingHistory";

const orderCoverage = {
  sellerKey: "seller",
  source: "tcgplayer_api" as const,
  status: "incomplete" as const,
  observedThrough: "2026-09-01T00:00:00.000Z",
  lastAttemptAt: "2026-09-02T00:00:00.000Z",
  ordersObserved: 8,
  detailsRecorded: 8,
  gaps: ["August import pending"],
};

const summary = {
  cohortQuantity: 10,
  knownListedDateQuantity: 8,
  unknownListedDateQuantity: 2,
  soldQuantity: 2,
  soldWithKnownListedDateQuantity: 2,
  remainingWithKnownAgeQuantity: 6,
  remainingWithUncertainPresenceQuantity: 1,
  removedQuantity: 1,
  soldOnlyAverageDays: 12.5,
  medianDaysToSale: null,
  p90DaysToSale: null,
  percentileStatus: "not_reached" as const,
  sellThrough: [
    { days: 7, eligibleQuantity: 8, soldQuantity: 1, rate: 0.125, status: "exact" as const },
    { days: 30, eligibleQuantity: 4, soldQuantity: 2, rate: 0.5, status: "exact" as const },
    { days: 60, eligibleQuantity: 0, soldQuantity: 0, rate: null, status: "exact" as const },
    { days: 90, eligibleQuantity: 0, soldQuantity: 0, rate: null, status: "exact" as const },
  ],
};

const ready: InventorySellingHistoryReport = {
  status: "ready",
  sellerKey: "seller",
  scope: { windowDays: 180, productLine: "Pokémon" },
  availableProductLines: ["Magic", "Pokémon"],
  analysisFrom: "2026-07-01T00:00:00.000Z",
  asOf: "2026-09-03T00:00:00.000Z",
  orderCoverage,
  overall: summary,
  productLines: [{ ...summary, productLine: "Pokémon" }],
  details: [{
    episodeKey: "publication:1",
    receiptId: 12,
    sku: 44,
    productLine: "Pokémon",
    productName: "Pikachu",
    kind: "confirmed_publication",
    quantity: 3,
    listedAt: "2026-08-01T00:00:00.000Z",
    soldQuantity: 2,
    removedQuantity: 0,
    ledgerRemainingQuantity: 1,
    remainingAgeDays: 33,
    presenceUncertain: false,
    forecastEvidenceProvenance: "recorded",
    forecastEvidence: null,
    orders: [{ orderNumber: "1001", quantity: 2, soldAt: "2026-08-14T00:00:00.000Z", listedDays: 13 }],
  }],
  detailTotal: 3,
  detailPage: 1,
  detailPageCount: 1,
  coverage: {
    pendingProjectionQuantity: 1,
    heldProjectionQuantity: 2,
    unresolvedRemovalQuantity: 1,
    affectedRemovalSkus: 1,
    openingUnknownQuantity: 2,
    legacyUnlinkedQuantity: 0,
    legacyUnlinkedForecastQuantity: 0,
    olderPublicationQuantity: 3,
    awaitingCutoffQuantity: 2,
  },
};

function render(report: InventorySellingHistoryReport, entry = "/inventory-strategy?historyPage=2&other=kept") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <InventorySellingHistory report={report} />
    </MemoryRouter>,
  );
}

const success = render(ready);
assert.match(success, /Observed listing exposure/);
assert.match(success, /Sold-only average/);
assert.match(success, /it is not an expected wait for all inventory/);
assert.match(success, /Unavailable: not reached/);
assert.match(success, /Age-eligible sell-through/);
assert.match(success, /showing 1 of 3/);
assert.match(success, /original opening quantity with unknown listed date/);
assert.match(success, /History gaps: August import pending/);
assert.match(success, /Order 1001/);
assert.match(success, /History window/);
assert.match(success, /Last 180 days/);
assert.match(success, /Pokémon/);
assert.match(success, /older publication excluded by window/);
assert.match(success, /awaiting cutoff/);
assert.doesNotMatch(success, /profit|cost basis|intake-to-sale days held/i);

const openingOnly = render({
  ...ready,
  overall: {
    ...summary,
    cohortQuantity: 7,
    knownListedDateQuantity: 0,
    unknownListedDateQuantity: 7,
    soldQuantity: 0,
    soldWithKnownListedDateQuantity: 0,
    remainingWithKnownAgeQuantity: 0,
    remainingWithUncertainPresenceQuantity: 0,
    removedQuantity: 0,
    sellThrough: summary.sellThrough.map((horizon) => ({
      ...horizon,
      eligibleQuantity: 0,
      soldQuantity: 0,
      rate: null,
    })),
  },
  productLines: [],
  details: [],
  detailTotal: 0,
  coverage: {
    ...ready.coverage,
    openingUnknownQuantity: 7,
    legacyUnlinkedQuantity: 4,
    legacyUnlinkedForecastQuantity: 3,
  },
});
const openingText = openingOnly.replace(/<[^>]*>/g, "");
assert.match(openingText, /Ledger expected remaining7 units/);
assert.match(openingText, /0 units with known age · 0 units uncertain presence · 7 units unknown listed date/);
assert.match(openingText, /7 units original opening quantity with unknown listed date/);
assert.match(openingText, /4 units legacy unlinked · 3 units with preserved forecast evidence/);

const unsettled = render({
  ...ready,
  overall: {
    ...summary,
    sellThrough: summary.sellThrough.map((horizon) =>
      horizon.days === 30
        ? { ...horizon, rate: null, status: "unsettled_outcomes" as const }
        : horizon,
    ),
  },
});
assert.match(unsettled.replace(/<[^>]*>/g, ""), /Unavailable: unsettled outcomes/);

const paginated = render({ ...ready, detailPageCount: 2 });
assert.match(paginated, /pagination navigation/);
assert.match(paginated, /page 2/i);

const empty = render({ ...ready, overall: { ...summary, cohortQuantity: 0 }, productLines: [], details: [], detailTotal: 0 });
assert.match(empty, /No published listing cohorts are available/);

const unavailable = render({
  status: "unavailable",
  sellerKey: "seller",
  scope: { windowDays: 730, productLine: null },
  availableProductLines: ["Magic", "Pokémon"],
  reason: "history_bounds_exceeded",
  orderCoverage,
});
assert.match(unavailable, /Selling history is unavailable: history bounds exceeded/);
assert.match(unavailable, /Order history: incomplete/);
assert.match(unavailable, /History window/);
assert.match(unavailable, /Last 730 days/);

console.log("PASS inventory selling history presents available, empty, unavailable, and bounded detail states");
