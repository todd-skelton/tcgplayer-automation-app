import { data } from "react-router";
import {
  inventoryBatchPricingJobsRepository,
  inventoryBatchesRepository,
  pricingConfigRepository,
} from "~/core/db";
import type { InventoryBatchPricingMode } from "../types/inventoryBatch";
import { ensureInventoryBatchPricingWorker } from "../services/inventoryBatchPricingWorker.server";

function parseBatchNumber(rawValue: string | undefined): number | null {
  const batchNumber = Number(rawValue);
  return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
}

function parseMode(rawValue: unknown): InventoryBatchPricingMode | null {
  return rawValue === "errors" || rawValue === "full" ? rawValue : null;
}

export async function action({
  params,
  request,
}: {
  params: { batchNumber?: string };
  request: Request;
}) {
  try {
    const batchNumber = parseBatchNumber(params.batchNumber);
    if (!batchNumber) {
      return data({ error: "Invalid batch number" }, { status: 400 });
    }

    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const batch = await inventoryBatchesRepository.findByBatchNumber(batchNumber);
    if (!batch) {
      return data({ error: `Batch ${batchNumber} not found` }, { status: 404 });
    }

    const payload = (await request.json()) as { mode?: InventoryBatchPricingMode };
    const mode = parseMode(payload.mode);
    if (!mode) {
      return data({ error: "Invalid pricing mode" }, { status: 400 });
    }

    const config = await pricingConfigRepository.get();
    const job = await inventoryBatchPricingJobsRepository.createOrReuseActiveJob(
      batchNumber,
      mode,
      {
        pricing: config.pricing,
        supplyAnalysis: config.supplyAnalysis,
        productLinePricing: config.productLinePricing,
      },
    );

    ensureInventoryBatchPricingWorker();

    return data(job, { status: 202 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
