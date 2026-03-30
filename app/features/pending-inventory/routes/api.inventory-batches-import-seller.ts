import { data } from "react-router";
import {
  inventoryBatchPricingJobsRepository,
  inventoryBatchesRepository,
  pricingConfigRepository,
} from "~/core/db";
import { ensureInventoryBatchPricingWorker } from "~/features/pending-inventory/services/inventoryBatchPricingWorker.server";
import { fetchSellerInventorySnapshot } from "~/features/seller-management/services/sellerInventorySnapshot.server";
import { convertSellerInventoryToBatchItems } from "~/features/file-upload/services/pricingBatchSnapshots.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const sellerKey = String(body.sellerKey ?? "").trim();

    if (!sellerKey) {
      return data({ error: "Seller key is required" }, { status: 400 });
    }

    const config = await pricingConfigRepository.get();
    const excludeProductLineIds = Object.entries(
      config.productLinePricing.productLineSettings,
    )
      .filter(([, settings]) => settings.skip)
      .map(([productLineId]) => Number(productLineId));

    const snapshot = await fetchSellerInventorySnapshot({
      sellerKey,
      excludeProductLineIds,
    });
    const items = await convertSellerInventoryToBatchItems(snapshot.inventory);

    if (items.length === 0) {
      return data(
        { error: `No seller inventory rows were available to import for ${sellerKey}` },
        { status: 400 },
      );
    }

    const batch = await inventoryBatchesRepository.createImportedBatch({
      sourceType: "seller",
      sourceLabel: sellerKey,
      items,
    });

    await inventoryBatchPricingJobsRepository.createOrReuseActiveJob(
      batch.batchNumber,
      "full",
      {
        pricing: config.pricing,
        supplyAnalysis: config.supplyAnalysis,
        productLinePricing: config.productLinePricing,
      },
    );

    ensureInventoryBatchPricingWorker();

    const queuedBatch = await inventoryBatchesRepository.findByBatchNumber(
      batch.batchNumber,
    );

    return data(queuedBatch ?? batch, { status: 201 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
