import assert from "node:assert/strict";
import { execute, getPool } from "../database.server";
import { inventoryPublicationsRepository } from "./inventoryPublications.server";

const planningKey = `integration-publication-${Date.now()}`;
const duplicatePlanningKey = `${planningKey}-duplicate-delta`;
const inventoryDeltaKey = `${planningKey}-inventory-delta`;
let publicationId: number | null = null;

try {
  const first = await inventoryPublicationsRepository.createOrFindPlanned({
    planningKey,
    method: "staged_delta",
    sourceType: "pending_inventory",
    config: { test: true },
    items: [
      {
        candidateKey: `${planningKey}-candidate`,
        inventoryDeltaKey,
        sku: 5199433,
        productId: 248731,
        productLine: "Pokemon",
        setName: "Celebrations",
        productName: "Greninja Star",
        condition: "Near Mint",
        desiredPrice: 24.99,
        quantityDelta: 1,
        pricedAt: new Date(),
      },
    ],
  });
  publicationId = first.publication.id;

  assert.equal(first.created, true);
  assert.equal(first.publication.items.length, 1);

  const repeated = await inventoryPublicationsRepository.createOrFindPlanned({
    planningKey,
    method: "staged_delta",
    sourceType: "pending_inventory",
    items: [
      {
        candidateKey: `${planningKey}-candidate`,
        inventoryDeltaKey,
        sku: 5199433,
        productId: 248731,
        productLine: "Pokemon",
        setName: "Celebrations",
        productName: "Greninja Star",
        condition: "Near Mint",
        desiredPrice: 24.99,
        quantityDelta: 1,
        pricedAt: new Date(),
      },
    ],
  });

  assert.equal(repeated.created, false);
  assert.equal(repeated.publication.id, first.publication.id);

  await assert.rejects(
    inventoryPublicationsRepository.createOrFindPlanned({
      planningKey: duplicatePlanningKey,
      method: "staged_delta",
      sourceType: "pending_inventory",
      items: [
        {
          candidateKey: `${planningKey}-different-candidate`,
          inventoryDeltaKey,
          sku: 5199433,
          productId: 248731,
          productLine: "Pokemon",
          setName: "Celebrations",
          productName: "Greninja Star",
          condition: "Near Mint",
          desiredPrice: 25.01,
          quantityDelta: 1,
          pricedAt: new Date(),
        },
      ],
    }),
  );

  const workerId = `${planningKey}-worker`;
  const claimed = await inventoryPublicationsRepository.claimNextPlanned(
    workerId,
    30_000,
  );
  assert.equal(claimed?.id, first.publication.id);
  assert.equal(claimed?.status, "staging");

  await inventoryPublicationsRepository.recordStagedUploadId(
    first.publication.id,
    workerId,
    16104570,
  );
  const staged = await inventoryPublicationsRepository.transitionStatus(
    first.publication.id,
    "staging",
    "staged",
    { workerId },
  );
  assert.equal(staged.stagedPricingUploadId, 16104570);

  await inventoryPublicationsRepository.transitionStatus(
    first.publication.id,
    "staged",
    "publishing",
    { workerId },
  );
  const published = await inventoryPublicationsRepository.transitionStatus(
    first.publication.id,
    "publishing",
    "published",
    { workerId },
  );
  assert.equal(published.status, "published");
  assert.ok(published.publishedAt);

  console.log(
    "PASS inventory publications persist idempotent plans, unique deltas, and lifecycle transitions",
  );
} finally {
  await execute(
    `DELETE FROM inventory_publication_items
    WHERE publication_id IN (
      SELECT id
      FROM inventory_publications
      WHERE planning_key IN ($1, $2)
    )`,
    [planningKey, duplicatePlanningKey],
  );
  await execute(
    `DELETE FROM inventory_publications
    WHERE planning_key IN ($1, $2)`,
    [planningKey, duplicatePlanningKey],
  );
  await getPool().end();
}
