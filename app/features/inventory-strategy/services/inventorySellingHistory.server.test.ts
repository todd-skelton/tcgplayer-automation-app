import assert from "node:assert/strict";
import type { SellingHistorySourceEvidence } from "../types/inventorySellingHistory";
import { loadInventorySellingHistory } from "./inventorySellingHistory.server";

const calls: string[] = [];
const source = {
  backfillSupportedForecastEvidence: async (sellerKey: string, limit = 0) => {
    calls.push(`backfill:${sellerKey}:${limit}`);
    return 0;
  },
  findEvidence: async (sellerKey: string, scope: SellingHistorySourceEvidence["scope"]): Promise<SellingHistorySourceEvidence> => {
    calls.push(`find:${sellerKey}`);
    return {
      sellerKey,
      scope,
      availableProductLines: [],
      analysisFrom: "2024-09-08T00:00:00.000Z",
      inventoryObservedAt: "2026-09-08T00:00:00.000Z",
      orderCoverage: {
        sellerKey,
        source: "tcgplayer_api",
        status: "complete",
        completedAt: "2026-09-08T00:00:00.000Z",
        ordersObserved: 0,
        detailsRecorded: 0,
        gaps: [],
      },
      episodes: [],
      episodeCount: 0,
      outcomes: [],
      outcomeCount: 0,
      projection: { pendingQuantity: 0, heldQuantity: 0, affectedSkus: [] },
      openingUnknownQuantity: 0,
      legacyUnlinked: { quantity: 0, forecastQuantity: 0 },
      olderPublicationQuantity: 0,
      awaitingCutoffQuantity: 0,
      unresolvedRemoval: { quantity: 0, affectedSkus: [] },
    };
  },
};

const report = await loadInventorySellingHistory(" seller ", { detailPage: 2 }, source);
assert.equal(report.status, "ready");
if (report.status === "ready") assert.equal(report.detailPage, 1);
assert.deepEqual(calls, ["backfill:seller:500", "find:seller"]);

calls.length = 0;
const missingSeller = await loadInventorySellingHistory("", {}, source);
assert.equal(missingSeller.status, "unavailable");
assert.deepEqual(calls, []);

console.log("PASS inventory selling history loads bounded evidence for one seller");
