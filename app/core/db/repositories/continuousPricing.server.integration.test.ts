import assert from "node:assert/strict";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { execute, getPool } from "../database.server";
import { continuousPricingRepository } from "./continuousPricing.server";

const sellerKey = `continuous-integration-${Date.now()}`;
let batchNumber: number | null = null;

try {
  await continuousPricingRepository.upsertSnapshot(sellerKey, [
    {
      sellerKey,
      sku: 5199433,
      productId: 248731,
      productLineId: 3,
      setId: 3059,
      productLine: "Pokemon",
      setName: "Celebrations",
      productName: "Greninja Star",
      condition: "Near Mint Holofoil",
      variant: "Holofoil",
      quantity: 29,
      currentPrice: 24.99,
      originalRow: {
        "TCGplayer Id": "5199433",
        "Product Line": "Pokemon",
        "Set Name": "Celebrations",
        Product: "Greninja Star",
        "Sku Variant": "Holofoil",
        "Sku Condition": "Near Mint Holofoil",
        "Sale Count": "",
        "Lowest Sale Price": "",
        "Highest Sale Price": "",
        "TCG Market Price": "",
        "Total Quantity": "29",
        "Add to Quantity": "0",
        "TCG Marketplace Price": "24.99",
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
    },
  ]);

  const inventory = await continuousPricingRepository.findPage({
    sellerKey,
    search: "",
    state: "all",
    page: 1,
    pageSize: 50,
  });
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0]?.quantity, 29);

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

  console.log(
    "PASS continuous pricing snapshot and due scheduling are durable and idempotent",
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
