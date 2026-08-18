import assert from "node:assert/strict";
import {
  DEFAULT_CONTINUOUS_PRICING_SETTINGS,
  type UpsertContinuousPricingInventoryItem,
} from "~/features/continuous-pricing/types/continuousPricing";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { execute, getPool } from "../database.server";
import { continuousPricingRepository } from "./continuousPricing.server";

const sellerKey = `continuous-integration-${Date.now()}`;
let batchNumber: number | null = null;

function createInventoryItem(
  sku: number,
  quantity: number,
  currentPrice: number,
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
      "TCG Market Price": "",
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

const inStockItem = createInventoryItem(5199433, 29, 24.99);
const outOfStockItem = createInventoryItem(5199434, 0, 12.34);

try {
  await continuousPricingRepository.upsertSnapshot(sellerKey, [
    inStockItem,
    outOfStockItem,
  ]);

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
  assert.equal(snapshot.pricedInStockSkuCount, 0);
  assert.equal(snapshot.publishedInStockSkuCount, 0);
  assert.equal(snapshot.needsReviewCount, 0);
  assert.equal(snapshot.outOfStockSkuCount, 1);

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
  assert.deepEqual(duplicate, { status: "backlogged" });

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
  assert.equal(publishedSnapshot.publishedInStockSkuCount, 1);

  await continuousPricingRepository.upsertSnapshot(
    sellerKey,
    [
      createInventoryItem(5199433, 29, 25.01),
      createInventoryItem(5199434, 2, 12.34),
    ],
    new Date(Date.now() + 1_000),
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

  console.log(
    "PASS continuous pricing schedules only positive stock and recognizes restocks",
  );
} finally {
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
  await getPool().end();
}
