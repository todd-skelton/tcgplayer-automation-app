import assert from "node:assert/strict";
import type {
  InventoryPublication,
  InventoryPublicationItem,
} from "~/features/inventory-publication/types/inventoryPublication";
import { summarizeLatestInventoryPublicationRun } from "./inventoryPublicationRunSummary";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function createItem(
  id: number,
  publicationId: number,
  status: InventoryPublicationItem["status"],
): InventoryPublicationItem {
  return {
    id,
    publicationId,
    candidateKey: `candidate:${id}`,
    inventoryDeltaKey: null,
    batchNumber: 90,
    sku: id,
    productId: id,
    productLine: "Pokemon",
    setName: "Test Set",
    productName: `Product ${id}`,
    condition: "Near Mint",
    previousPrice: 1,
    desiredPrice: 2,
    quantityDelta: 0,
    observedQuantity: null,
    desiredAbsoluteQuantity: null,
    pricedAt: NOW,
    eligibilityReasons: [],
    status,
    errorCode: null,
    errorMessage: null,
    publishedAt: status === "published" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function createPublication(
  id: number,
  itemCount: number,
  status: InventoryPublication["status"] = "published",
): InventoryPublication {
  return {
    id,
    planningKey: `publication:${id}`,
    batchNumber: 90,
    pricingJobId: 21,
    method: "staged_delta",
    sourceType: "pending_inventory",
    sellerKey: null,
    status,
    stagedPricingUploadId: id,
    config: {},
    progress: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 1,
    claimedBy: null,
    claimExpiresAt: null,
    stagedAt: NOW,
    publishingAt: NOW,
    publishedAt: status === "published" ? NOW : null,
    completedAt: status === "published" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
    items: Array.from({ length: itemCount }, (_, index) =>
      createItem(
        id * 1_000 + index,
        id,
        status === "published" ? "published" : "planned",
      ),
    ),
  };
}

const completed = summarizeLatestInventoryPublicationRun([
  createPublication(2, 175),
  createPublication(1, 250),
]);

assert.deepEqual(completed, {
  status: "published",
  publicationCount: 2,
  publishedCount: 425,
  failedCount: 0,
  ambiguousCount: 0,
});

const inProgress = summarizeLatestInventoryPublicationRun([
  createPublication(2, 175, "planned"),
  createPublication(1, 250),
]);

assert.equal(inProgress?.status, "in_progress");
assert.equal(inProgress?.publishedCount, 250);
assert.equal(inProgress?.publicationCount, 2);

console.log("PASS inventory publication summaries include every staged batch");
