import assert from "node:assert/strict";
import {
  DEFAULT_CONTINUOUS_PRICING_SETTINGS,
  type UpsertContinuousPricingInventoryItem,
} from "~/features/continuous-pricing/types/continuousPricing";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { execute, getPool, queryOne } from "../database.server";
import { continuousPricingRepository } from "./continuousPricing.server";

const sellerKey = `continuous-integration-${Date.now()}`;
let batchNumber: number | null = null;
let pendingBatchNumber: number | null = null;
let publicationId: number | null = null;

function createInventoryItem(
  sku: number,
  quantity: number,
  currentPrice: number,
  marketPrice = currentPrice,
): UpsertContinuousPricingInventoryItem {
  return {
    sellerKey,
    sku,
    productId: 248731,
    productLineId: 3,
    setId: 3059,
    productLine: "Pokemon",
    setName: "Celebrations",
    productName: "Greninja Star",
    condition: "Near Mint Holofoil",
    variant: "Holofoil",
    quantity,
    currentPrice,
    marketPrice,
    originalRow: {
      "TCGplayer Id": String(sku),
      "Product Line": "Pokemon",
      "Set Name": "Celebrations",
      Product: "Greninja Star",
      "Sku Variant": "Holofoil",
      "Sku Condition": "Near Mint Holofoil",
      "Sale Count": "",
      "Lowest Sale Price": "",
      "Highest Sale Price": "",
      "TCG Market Price": String(marketPrice),
      "Total Quantity": String(quantity),
      "Add to Quantity": "0",
      "TCG Marketplace Price": String(currentPrice),
      "Previous Price": "",
      "Suggested Price": "",
      "Percentile Used": "",
      "Historical Sales Velocity (Days)": "",
      "Estimated Time to Sell (Days)": "",
      "Sales Count for Historical Calculation": "",
      "Listings Count for Estimated Calculation": "",
      Warning: "",
      Error: "",
    },
  };
}

const inStockItem = createInventoryItem(5199433, 29, 24.99, 20);
const outOfStockItem = createInventoryItem(5199434, 0, 12.34, 10);

try {
  await continuousPricingRepository.upsertSnapshot(
    sellerKey,
    [inStockItem, outOfStockItem],
    { minimumIntervalMinutes: 60 },
  );

  const inventory = await continuousPricingRepository.findPage({
    sellerKey,
    search: "",
    state: "all",
    page: 1,
    pageSize: 50,
  });
  assert.equal(inventory.items.length, 2);
  assert.equal(inventory.items[0]?.quantity, 29);
  assert.equal(inventory.items[1]?.quantity, 0);
  assert.equal(inventory.items[1]?.inStock, false);

  const snapshot = await continuousPricingRepository.getStatus(sellerKey, {
    ...DEFAULT_CONTINUOUS_PRICING_SETTINGS,
    sellerKey,
  });
  assert.equal(snapshot.inventoryCount, 2);
  assert.equal(snapshot.inStockSkuCount, 1);
  assert.equal(snapshot.availableUnitCount, 29);
  assert.equal(snapshot.currentInventoryValue, 724.71);
  assert.equal(snapshot.currentMarketValue, 580);
  assert.equal(snapshot.marketComparableMarketValue, 580);
  assert.equal(snapshot.marketComparableListedValue, 724.71);
  assert.equal(snapshot.marketValueSkuCount, 1);
  assert.equal(snapshot.pricedInStockSkuCount, 0);
  assert.equal(snapshot.pricedAwaitingPublicationCount, 0);
  assert.equal(snapshot.pricedAwaitingPublicationUnitCount, 0);
  assert.equal(snapshot.needsReviewCount, 0);

  const scheduled = await continuousPricingRepository.scheduleDueBatch({
    sellerKey,
    batchSize: 100,
    minimumIntervalMinutes: 60,
    pricingConfig: DEFAULT_SERVER_PRICING_CONFIG,
  });
  assert.ok(scheduled && scheduled.status === "scheduled");
  batchNumber = scheduled.batchNumber;
  assert.equal(scheduled.itemCount, 1);

  const duplicate = await continuousPricingRepository.scheduleDueBatch({
    sellerKey,
    batchSize: 100,
    minimumIntervalMinutes: 60,
    pricingConfig: DEFAULT_SERVER_PRICING_CONFIG,
  });
  assert.equal(duplicate, null);

  await continuousPricingRepository.recordPublishedPrices(sellerKey, [
    { sku: 5199433, price: 25.01 },
  ]);
  const published = await continuousPricingRepository.findPage({
    sellerKey,
    search: "",
    state: "all",
    page: 1,
    pageSize: 50,
  });
  assert.equal(published.items[0]?.currentPrice, 25.01);
  assert.ok(published.items[0]?.lastPublishedAt);

  const publishedSnapshot = await continuousPricingRepository.getStatus(
    sellerKey,
    snapshot.settings,
  );
  assert.equal(publishedSnapshot.currentInventoryValue, 725.29);
  assert.equal(publishedSnapshot.currentMarketValue, 580);
  assert.equal(publishedSnapshot.marketComparableListedValue, 725.29);
  assert.equal(publishedSnapshot.pricedAwaitingPublicationCount, 0);

  const directPricedAt = new Date(Date.now() + 1_000);
  const directPublishedAt = new Date(Date.now() + 2_000);
  const projected =
    await continuousPricingRepository.recordInventoryManagementPublication(
      sellerKey,
      [
        {
          sku: 5199434,
          price: 12.5,
          pricedAt: directPricedAt,
          publishedAt: directPublishedAt,
        },
      ],
      60,
    );
  assert.equal(projected, 1);
  const directlyProjected = await continuousPricingRepository.findPage({
    sellerKey,
    search: "5199434",
    state: "all",
    page: 1,
    pageSize: 50,
  });
  assert.equal(directlyProjected.items[0]?.currentPrice, 12.5);
  assert.equal(
    directlyProjected.items[0]?.lastPricedAt?.getTime(),
    directPricedAt.getTime(),
  );
  assert.equal(
    directlyProjected.items[0]?.lastPublishedAt?.getTime(),
    directPublishedAt.getTime(),
  );

  const refreshPricedAt = new Date(Date.now() + 3_000);
  const refreshPublishedAt = new Date(Date.now() + 4_000);
  const pendingBatch = await queryOne<{ batchNumber: number }>(
    `INSERT INTO inventory_batches (status, source_type, source_label)
    VALUES ('priced', 'pending_inventory', 'Inventory Manager')
    RETURNING batch_number AS "batchNumber"`,
  );
  assert.ok(pendingBatch);
  pendingBatchNumber = pendingBatch.batchNumber;
  await execute(
    `INSERT INTO inventory_batch_items (
      batch_number,
      sku,
      total_quantity,
      add_to_quantity,
      current_price,
      product_line_id,
      set_id,
      product_id,
      original_row_json,
      created_at,
      updated_at
    ) VALUES ($1, 5199435, 0, 2, NULL, 3, 3059, 248731, $2::jsonb, NOW(), NOW())`,
    [
      pendingBatchNumber,
      JSON.stringify(createInventoryItem(5199435, 2, 17.89).originalRow),
    ],
  );
  await execute(
    `INSERT INTO inventory_batch_results (
      batch_number,
      sku,
      result_status,
      row_json,
      priced_at
    ) VALUES ($1, 5199435, 'successful', $2::jsonb, $3)`,
    [
      pendingBatchNumber,
      JSON.stringify(createInventoryItem(5199435, 2, 17.89).originalRow),
      refreshPricedAt,
    ],
  );

  const awaitingPublication = await continuousPricingRepository.getStatus(
    sellerKey,
    snapshot.settings,
  );
  assert.equal(awaitingPublication.pricedAwaitingPublicationCount, 1);
  assert.equal(awaitingPublication.pricedAwaitingPublicationUnitCount, 2);

  const publication = await queryOne<{ id: number }>(
    `INSERT INTO inventory_publications (
      planning_key,
      batch_number,
      method,
      source_type,
      seller_key,
      status,
      published_at,
      completed_at
    ) VALUES ($1, $2, 'staged_delta', 'pending_inventory', $3, 'published', $4, $4)
    RETURNING id`,
    [
      `continuous-integration-publication:${sellerKey}`,
      pendingBatchNumber,
      sellerKey,
      refreshPublishedAt,
    ],
  );
  assert.ok(publication);
  publicationId = publication.id;
  await execute(
    `INSERT INTO inventory_publication_items (
      publication_id,
      candidate_key,
      inventory_delta_key,
      batch_number,
      sku,
      product_id,
      product_line,
      set_name,
      product_name,
      condition,
      desired_price,
      quantity_delta,
      priced_at,
      status,
      published_at
    ) VALUES (
      $1, $2, $3, $4, 5199435, 248731, 'Pokemon', 'Celebrations',
      'Greninja Star', 'Near Mint Holofoil', 17.89, 2, $5, 'published', $6
    )`,
    [
      publicationId,
      `continuous-integration-candidate:${sellerKey}`,
      `inventory-batch-item:${pendingBatchNumber}:5199435`,
      pendingBatchNumber,
      refreshPricedAt,
      refreshPublishedAt,
    ],
  );

  const publishedInventory = await continuousPricingRepository.getStatus(
    sellerKey,
    snapshot.settings,
  );
  assert.equal(publishedInventory.pricedAwaitingPublicationCount, 0);
  assert.equal(publishedInventory.pricedAwaitingPublicationUnitCount, 0);

  await continuousPricingRepository.upsertSnapshot(
    sellerKey,
    [
      createInventoryItem(5199433, 29, 25.01),
      createInventoryItem(5199434, 2, 12.5),
      createInventoryItem(5199435, 1, 17.89),
    ],
    {
      minimumIntervalMinutes: 60,
      observedAt: new Date(Date.now() + 1_000),
    },
  );
  const restocked = await continuousPricingRepository.findPage({
    sellerKey,
    search: "5199434",
    state: "in_stock",
    page: 1,
    pageSize: 50,
  });
  assert.equal(restocked.total, 1);
  assert.equal(restocked.items[0]?.quantity, 2);
  assert.equal(restocked.items[0]?.inStock, true);

  const refreshedProjection = await continuousPricingRepository.findPage({
    sellerKey,
    search: "5199435",
    state: "in_stock",
    page: 1,
    pageSize: 50,
  });
  assert.equal(refreshedProjection.total, 1);
  assert.equal(
    refreshedProjection.items[0]?.lastPricedAt?.getTime(),
    refreshPricedAt.getTime(),
  );
  assert.equal(
    refreshedProjection.items[0]?.lastPublishedAt?.getTime(),
    refreshPublishedAt.getTime(),
  );
  assert.ok(
    (refreshedProjection.items[0]?.nextPriceAt.getTime() ?? 0) >=
      refreshPublishedAt.getTime() + 60 * 60 * 1_000,
  );

  console.log(
    "PASS continuous pricing inherits confirmed Inventory Management pricing",
  );
} finally {
  if (publicationId !== null) {
    await execute(
      `DELETE FROM inventory_publication_items WHERE publication_id = $1`,
      [publicationId],
    );
    await execute(`DELETE FROM inventory_publications WHERE id = $1`, [
      publicationId,
    ]);
  }
  await execute(
    `DELETE FROM continuous_pricing_inventory WHERE seller_key = $1`,
    [sellerKey],
  );
  await execute(
    `DELETE FROM continuous_pricing_refreshes WHERE seller_key = $1`,
    [sellerKey],
  );
  if (batchNumber !== null) {
    await execute(`DELETE FROM inventory_batches WHERE batch_number = $1`, [
      batchNumber,
    ]);
  }
  if (pendingBatchNumber !== null) {
    await execute(`DELETE FROM inventory_batches WHERE batch_number = $1`, [
      pendingBatchNumber,
    ]);
  }
  await getPool().end();
}
