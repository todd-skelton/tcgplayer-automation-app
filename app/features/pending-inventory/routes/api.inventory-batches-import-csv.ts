import Papa from "papaparse";
import { data } from "react-router";
import type { TcgPlayerListing } from "~/core/types/pricing";
import {
  inventoryBatchPricingJobsRepository,
  inventoryBatchesRepository,
  pricingConfigRepository,
} from "~/core/db";
import { ensureInventoryBatchPricingWorker } from "~/features/pending-inventory/services/inventoryBatchPricingWorker.server";
import { convertCsvListingsToBatchItems } from "~/features/file-upload/services/pricingBatchSnapshots.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return data({ error: "CSV file is required" }, { status: 400 });
    }

    const csvText = await file.text();
    const parsed = Papa.parse<TcgPlayerListing>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    const items = await convertCsvListingsToBatchItems(parsed.data);
    if (items.length === 0) {
      return data(
        { error: `No valid CSV rows were available to import from ${file.name}` },
        { status: 400 },
      );
    }

    const batch = await inventoryBatchesRepository.createImportedBatch({
      sourceType: "csv",
      sourceLabel: file.name,
      items,
    });

    const config = await pricingConfigRepository.get();
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
