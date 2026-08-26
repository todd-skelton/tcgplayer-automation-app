import type { TcgPlayerListing } from "~/core/types/pricing";
import {
  inventoryBatchPricingJobsRepository,
  inventoryBatchesRepository,
  inventoryStrategyRepository,
  pricingConfigRepository,
} from "~/core/db";
import { ensureInventoryBatchPricingWorker } from "~/features/pending-inventory/services/inventoryBatchPricingWorker.server";
import type { InventoryBatch } from "~/features/pending-inventory/types/inventoryBatch";
import type { InventoryStrategySnapshotItem } from "../types/inventoryStrategy";

function toOriginalRow(item: InventoryStrategySnapshotItem): TcgPlayerListing {
  return {
    "TCGplayer Id": String(item.sku),
    "Product Line": item.productLine,
    "Set Name": item.setName,
    Product: item.productName,
    "Sku Variant": item.variant,
    "Sku Condition": item.condition,
    "Sale Count": "",
    "Lowest Sale Price": "",
    "Highest Sale Price": "",
    "TCG Market Price":
      item.marketPrice === null ? "" : String(item.marketPrice),
    "Total Quantity": String(item.quantity),
    "Add to Quantity": "0",
    "TCG Marketplace Price":
      item.currentPrice === null ? "" : String(item.currentPrice),
    "Previous Price": "",
    "Suggested Price": "",
    "Percentile Used": "",
    "Historical Sales Velocity (Days)": "",
    "Estimated Time to Sell (Days)": "",
    "Sales Count for Historical Calculation": "",
    "Listings Count for Estimated Calculation": "",
    Warning: "",
    Error: "",
  };
}

export async function queueInventoryStrategyAnalysis(
  sellerKey: string,
): Promise<{ batch: InventoryBatch; created: boolean }> {
  const recent = await inventoryBatchesRepository.findRecent({
    sourceTypes: ["strategy"],
    limit: 25,
  });
  const active = recent.find(
    (batch) =>
      batch.sourceLabel === sellerKey &&
      (batch.status === "queued" || batch.status === "pricing"),
  );
  if (active) {
    return { batch: active, created: false };
  }

  const items = await inventoryStrategyRepository.findSnapshot(sellerKey);
  if (items.length === 0) {
    throw new Error(
      "No in-stock inventory snapshot is available. Refresh inventory first.",
    );
  }

  const config = await pricingConfigRepository.get();
  const batch = await inventoryBatchesRepository.createImportedBatch({
    sourceType: "strategy",
    sourceLabel: sellerKey,
    items: items.map((item) => ({
      sku: item.sku,
      totalQuantity: item.quantity,
      addToQuantity: 0,
      currentPrice: item.currentPrice,
      productLineId: item.productLineId,
      setId: item.setId,
      productId: item.productId,
      originalRow: toOriginalRow(item),
    })),
  });

  await inventoryBatchPricingJobsRepository.createOrReuseActiveJob(
    batch.batchNumber,
    "full",
    config,
  );
  ensureInventoryBatchPricingWorker();

  return {
    batch:
      (await inventoryBatchesRepository.findByBatchNumber(batch.batchNumber)) ??
      batch,
    created: true,
  };
}
