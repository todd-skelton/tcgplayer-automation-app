import assert from "node:assert/strict";
import {
  DEFAULT_CONTINUOUS_PRICING_SETTINGS,
  type UpsertContinuousPricingInventoryItem,
} from "~/features/continuous-pricing/types/continuousPricing";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { execute, getPool, queryOne } from "../database.server";
import { continuousPricingRepository } from "./continuousPricing.server";
import { inventoryStrategyRepository } from "./inventoryStrategy.server";
import { inventoryBatchPricingJobsRepository } from "./inventoryBatchPricingJobs.server";
import { inventoryBatchesRepository } from "./inventoryBatches.server";
import { inventoryPublicationSettingsRepository } from "./inventoryPublicationSettings.server";
import { PricedSkuToTcgPlayerListingConverter } from "~/features/file-upload/services/dataConverters";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import type { PersistedPricingDetails } from "~/core/types/pricing";
import { executeInventoryBatchPricingJob } from "~/features/pending-inventory/services/inventoryBatchPricing.server";
import { pricingConfigRepository } from "./pricingConfig.server";
import { planAutomaticInventoryBatchPublication } from "~/features/inventory-publication/services/automaticInventoryBatchPublication.server";

const sellerKey = `continuous-integration-${Date.now()}`;
let batchNumber: number | null = null;
let pendingBatchNumber: number | null = null;
let publicationId: number | null = null;
const cachedBatchNumbers: number[] = [];
const originalPublicationSettings =
  await inventoryPublicationSettingsRepository.get();
process.env.WORKERS_RUN_IN_PROCESS = "false";

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
    pricingEligible: true,
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

  await execute(
    `UPDATE continuous_pricing_inventory
    SET next_price_at = NOW() + INTERVAL '1 day'
    WHERE seller_key = $1`,
    [sellerKey],
  );
  assert.equal(
    await continuousPricingRepository.makeEligibleInventoryDue(sellerKey),
    1,
  );
  const dueInventory = await continuousPricingRepository.findPage({
    sellerKey,
    search: "",
    state: "due",
    page: 1,
    pageSize: 50,
  });
  assert.equal(dueInventory.total, 1);
  assert.equal(dueInventory.items[0]?.sku, inStockItem.sku);

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

  const staleSnapshotObservedAt = new Date(
    (published.items[0]?.lastPublishedAt?.getTime() ?? Date.now()) - 1,
  );
  await continuousPricingRepository.upsertSnapshot(
    sellerKey,
    [createInventoryItem(5199433, 29, 24.99, 20), outOfStockItem],
    { minimumIntervalMinutes: 60, observedAt: staleSnapshotObservedAt },
  );
  const afterStaleSnapshot = await continuousPricingRepository.findPage({
    sellerKey,
    search: "5199433",
    state: "all",
    page: 1,
    pageSize: 50,
  });
  assert.equal(afterStaleSnapshot.items[0]?.currentPrice, 25.01);

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

  await continuousPricingRepository.upsertSnapshot(
    sellerKey,
    [
      createInventoryItem(5199433, 29, 25.01),
      createInventoryItem(5199434, 2, 12.5),
      createInventoryItem(5199435, 1, 17.89),
      createInventoryItem(5199436, 1, 3),
    ],
    { minimumIntervalMinutes: 60 },
  );
  const dataAt = new Date(Date.now() - 30 * 60_000);
  await execute(
    `UPDATE continuous_pricing_inventory SET market_price = 10
    WHERE seller_key = $1 AND sku IN (5199433, 5199435)`,
    [sellerKey],
  );
  await execute(
    `UPDATE inventory_batch_pricing_jobs SET status = 'completed' WHERE batch_number = $1`,
    [batchNumber],
  );
  await inventoryPublicationSettingsRepository.save({
    ...originalPublicationSettings.settings,
    continuousPricing: {
      ...DEFAULT_CONTINUOUS_PRICING_SETTINGS,
      sellerKey,
      minimumIntervalMinutes: 60,
    },
    policy: {
      ...originalPublicationSettings.settings.policy,
      automaticPublishingEnabled: true,
      automaticSources: {
        ...originalPublicationSettings.settings.policy.automaticSources,
        continuous: true,
      },
    },
  });
  for (const sku of [5199433, 5199434, 5199435]) {
    const marketDataAt =
      sku === 5199434 ? new Date(Date.now() - 120 * 60_000) : dataAt;
    await execute(
      `INSERT INTO inventory_strategy_pricing_curves (seller_key,sku,pricing_details_json,priced_at,batch_number)
      VALUES ($1,$2,$3::jsonb,NOW(),$4)`,
      [
        sellerKey,
        sku,
        JSON.stringify({
          schemaVersion: 2,
          pricingModelVersion: PRICING_MODEL_VERSION,
          pricedAt: new Date().toISOString(),
          marketDataAt: marketDataAt.toISOString(),
          decision: { basis: "modeled", forecastStatus: "interpolated" },
          percentiles: [
            {
              percentile: 65,
              suggestedPrice: 12,
              supplyStatus: "observed",
              estimatedTimeToSellDays: 24,
            },
          ],
        }),
        batchNumber,
      ],
    );
  }
  const cachedInput = {
    sellerKey,
    batchSize: 1,
    minimumIntervalMinutes: 60,
    pricingModelVersion: PRICING_MODEL_VERSION,
    pricingConfig: {
      ...DEFAULT_SERVER_PRICING_CONFIG,
      pricing: {
        ...DEFAULT_SERVER_PRICING_CONFIG.pricing,
        policy: { method: "target-horizon" as const, horizonDays: 24 },
      },
    },
  };
  // A later retry's settings must not describe an earlier result's source data.
  await execute(
    `INSERT INTO inventory_batch_pricing_jobs (batch_number, mode, status, config_json, created_at)
    VALUES ($1, 'full', 'completed', $2::jsonb, NOW() + INTERVAL '1 minute')`,
    [
      batchNumber,
      JSON.stringify({
        ...cachedInput.pricingConfig,
        supplyAnalysis: {
          ...cachedInput.pricingConfig.supplyAnalysis,
          includeUnverifiedSellers: true,
        },
      }),
    ],
  );
  const cached =
    await continuousPricingRepository.scheduleCachedPolicyBatches(cachedInput);
  cachedBatchNumbers.push(...cached.batchNumbers);
  assert.equal(cached.cachedCount, 2);
  assert.equal(cached.refreshCount, 2);
  assert.equal(cached.batchNumbers.length, 2);
  await assert.rejects(
    () => continuousPricingRepository.scheduleCachedPolicyBatches(cachedInput),
    /already queued/,
  );
  for (const number of cached.batchNumbers) {
    const job =
      await inventoryBatchPricingJobsRepository.findLatestByBatchNumber(number);
    assert.equal(job?.mode, "cached");
    assert.deepEqual(job?.config.pricing.policy, {
      method: "target-horizon",
      horizonDays: 24,
    });
    assert.ok(job);
    const execution = await executeInventoryBatchPricingJob({
      batchNumber: number,
      mode: "cached",
      config: job.config,
    });
    assert.equal(
      execution.pricedSkus[0]?.pricingDecision?.targetHorizonDays,
      24,
    );
    assert.equal(execution.pricedSkus[0]?.marketDataAt, dataAt.toISOString());
    assert.equal(execution.pricedSkus[0]?.errors?.length, 0);
    const rows =
      new PricedSkuToTcgPlayerListingConverter().convertFromPricedSkus(
        execution.pricedSkus,
      );
    const pricedAt = new Date();
    await inventoryBatchesRepository.saveResults({
      batchNumber: number,
      mode: "cached",
      rows: execution.pricedSkus.map((item, index) => ({
        sku: item.sku,
        resultStatus: "successful",
        row: rows[index],
        pricingDetails: {
          schemaVersion: 2,
          marketplacePrice: item.price,
          marketDataAt: item.marketDataAt,
          pricedAt: pricedAt.toISOString(),
        },
        errorMessages: item.errors ?? [],
        warningMessages: item.warnings ?? [],
        pricedAt,
      })),
    });
    await inventoryBatchPricingJobsRepository.complete(
      job.id,
      execution.summary,
    );
  }
  const cachedInventory = await continuousPricingRepository.findPage({
    sellerKey,
    search: "5199433",
    state: "all",
    page: 1,
    pageSize: 50,
  });
  assert.equal(
    cachedInventory.items[0]?.nextPriceAt.getTime(),
    dataAt.getTime() + 60 * 60_000,
  );
  const cachedSnapshot =
    await inventoryStrategyRepository.findReusableSnapshots(
      sellerKey,
      [5199433],
      60,
      cachedInput.pricingConfig.supplyAnalysis,
    );
  assert.equal(
    cachedSnapshot[0]?.strategyPricedAt?.getTime(),
    dataAt.getTime(),
  );
  const refreshDue = await continuousPricingRepository.findPage({
    sellerKey,
    search: "",
    state: "due",
    page: 1,
    pageSize: 50,
  });
  assert.deepEqual(
    refreshDue.items.map((item) => item.sku).sort(),
    [5199434, 5199436],
  );
  const originalConfig = await pricingConfigRepository.get();
  try {
    await pricingConfigRepository.save(cachedInput.pricingConfig);
    for (const [index, number] of cached.batchNumbers.entries()) {
      const mode = index === 0 ? "full" : "cached";
      await execute(
        `UPDATE inventory_batch_pricing_jobs SET mode = $2, config_json = $3::jsonb
        WHERE batch_number = $1`,
        [
          number,
          mode,
          JSON.stringify({
            ...cachedInput.pricingConfig,
            ...(mode === "cached" ? { updatedAt: dataAt.toISOString() } : {}),
          }),
        ],
      );
      const publication = await planAutomaticInventoryBatchPublication(number);
      assert.equal(
        publication.planned,
        true,
        `${mode} must publish unchanged settings`,
      );
      if (publication.planned) {
        await execute(
          `DELETE FROM inventory_publication_items WHERE publication_id = $1`,
          [publication.publicationId],
        );
        await execute(`DELETE FROM inventory_publications WHERE id = $1`, [
          publication.publicationId,
        ]);
      }
    }
    for (const pricing of [
      {
        ...cachedInput.pricingConfig.pricing,
        policy: { method: "target-horizon" as const, horizonDays: 20 },
      },
      {
        ...cachedInput.pricingConfig.pricing,
        minPriceConstant:
          cachedInput.pricingConfig.pricing.minPriceConstant + 1,
      },
    ]) {
      await pricingConfigRepository.save({
        ...cachedInput.pricingConfig,
        pricing,
      });
      assert.deepEqual(
        await planAutomaticInventoryBatchPublication(cached.batchNumbers[0]),
        {
          planned: false,
          reason: "superseded_pricing_config",
        },
      );
    }
  } finally {
    await pricingConfigRepository.save(originalConfig);
  }
  console.log(
    "PASS unchanged routine and cached settings can publish; changed settings cannot",
  );

  const originalCurve = await queryOne<{
    details: PersistedPricingDetails;
    batchNumber: number;
    pricedAt: Date;
  }>(
    `SELECT pricing_details_json AS details, batch_number AS "batchNumber", priced_at AS "pricedAt"
    FROM inventory_strategy_pricing_curves WHERE seller_key = $1 AND sku = 5199433`,
    [sellerKey],
  );
  assert.ok(originalCurve);
  await execute(
    `UPDATE inventory_batch_pricing_jobs SET config_json = jsonb_set(config_json,
      '{supplyAnalysis,includeUnverifiedSellers}', 'true') WHERE batch_number = $1`,
    [cached.batchNumbers[1]],
  );
  for (const replacement of [
    {
      ...originalCurve,
      details: {
        ...originalCurve.details,
        marketDataAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      },
    },
    {
      ...originalCurve,
      batchNumber: cached.batchNumbers[1],
      pricedAt: new Date(),
    },
    {
      ...originalCurve,
      details: { ...originalCurve.details, percentiles: [] },
    },
  ]) {
    await execute(
      `UPDATE inventory_strategy_pricing_curves
      SET pricing_details_json = $2::jsonb, batch_number = $3, priced_at = $4
      WHERE seller_key = $1 AND sku = 5199433`,
      [
        sellerKey,
        JSON.stringify(replacement.details),
        replacement.batchNumber,
        replacement.pricedAt,
      ],
    );
    await execute(
      `UPDATE continuous_pricing_inventory SET next_price_at = NOW() + INTERVAL '30 minutes'
      WHERE seller_key = $1 AND sku = 5199433`,
      [sellerKey],
    );
    const deferred = await executeInventoryBatchPricingJob({
      batchNumber: cached.batchNumbers[0],
      mode: "cached",
      config: cachedInput.pricingConfig,
    });
    assert.deepEqual(deferred.pricedSkus, []);
    assert.equal(deferred.summary.skippedRows, 1);
    assert.equal(deferred.summary.errorRows, 0);
    await inventoryBatchesRepository.saveResults({
      batchNumber: cached.batchNumbers[0],
      mode: "cached",
      rows: [],
    });
    const deferredJob =
      await inventoryBatchPricingJobsRepository.findLatestByBatchNumber(
        cached.batchNumbers[0],
      );
    assert.ok(deferredJob);
    await inventoryBatchPricingJobsRepository.complete(
      deferredJob.id,
      deferred.summary,
      deferred.finalProgress,
    );
    await continuousPricingRepository.recordBatchCompleted(
      cached.batchNumbers[0],
    );
    const inventory = await continuousPricingRepository.findPage({
      sellerKey,
      search: "5199433",
      state: "due",
      page: 1,
      pageSize: 50,
    });
    assert.equal(inventory.total, 1);
    assert.equal(inventory.items[0]?.consecutivePricingFailures, 0);
    const batch = await inventoryBatchesRepository.findByBatchNumber(
      cached.batchNumbers[0],
    );
    assert.equal(
      batch?.successfulCount,
      0,
      "cached retries must remove superseded results",
    );
    assert.equal(batch?.status, "priced");
    assert.equal(batch?.latestJob?.status, "completed");
    assert.equal(
      batch?.lastPricedAt,
      null,
      "Skipped work must not invent a price timestamp",
    );
    assert.equal(batch?.summary?.totalRows, 1);
    assert.equal(batch?.summary?.processedRows, 0);
    assert.equal(batch?.summary?.skippedRows, 1);
    assert.equal(batch?.summary?.manualReviewRows, 0);
    assert.equal(batch?.summary?.errorRows, 0);
    assert.equal(batch?.summary?.totals.marketplacePrice, 0);
  }
  await execute(
    `INSERT INTO inventory_batch_items (batch_number, sku, total_quantity, add_to_quantity,
      current_price, product_line_id, set_id, product_id, original_row_json, created_at, updated_at)
    SELECT $1, sku, total_quantity, add_to_quantity, current_price,
      product_line_id, set_id, product_id, original_row_json, created_at, updated_at
    FROM inventory_batch_items WHERE batch_number = $2`,
    cached.batchNumbers,
  );
  const mixed = await executeInventoryBatchPricingJob({
    batchNumber: cached.batchNumbers[0],
    mode: "cached",
    config: cachedInput.pricingConfig,
  });
  assert.deepEqual(
    mixed.pricedSkus.map((item) => item.sku),
    [5199435],
  );
  assert.equal(mixed.summary.skippedRows, 1);
  assert.equal(mixed.summary.errorRows, 0);
  await execute(
    `UPDATE continuous_pricing_inventory SET next_price_at = NOW() + INTERVAL '30 minutes'
    WHERE seller_key = $1 AND sku <> 5199433`,
    [sellerKey],
  );
  const refresh = await continuousPricingRepository.scheduleDueBatch({
    ...cachedInput,
    batchSize: 100,
  });
  assert.ok(refresh?.status === "scheduled");
  cachedBatchNumbers.push(refresh.batchNumber);
  const refreshItems = await inventoryBatchesRepository.findItems(
    refresh.batchNumber,
    "all",
  );
  assert.ok(refreshItems.some((item) => item.sku === 5199433));
  assert.equal(
    (
      await inventoryBatchPricingJobsRepository.findLatestByBatchNumber(
        refresh.batchNumber,
      )
    )?.mode,
    "full",
  );
  console.log(
    "PASS expired, replaced, and empty curves defer to fresh pricing without failures or stale results",
  );
  console.log(
    "PASS cached policy batches preserve data age and leave stale or missing curves due",
  );
} finally {
  await inventoryPublicationSettingsRepository.save(
    originalPublicationSettings.settings,
  );
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
  await execute(
    `DELETE FROM inventory_strategy_pricing_curves WHERE seller_key = $1`,
    [sellerKey],
  );
  for (const number of cachedBatchNumbers) {
    await execute(`DELETE FROM inventory_batches WHERE batch_number = $1`, [
      number,
    ]);
  }
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
