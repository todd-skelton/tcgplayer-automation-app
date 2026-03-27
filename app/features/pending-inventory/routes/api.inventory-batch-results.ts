import { data } from "react-router";
import type { PricedSku } from "~/core/types/pricing";
import { inventoryBatchesRepository } from "~/core/db";
import { PricedSkuToTcgPlayerListingConverter } from "~/features/file-upload/services/dataConverters";
import type {
  InventoryBatchPricingMode,
  InventoryBatchResultsScope,
} from "../types/inventoryBatch";

const converter = new PricedSkuToTcgPlayerListingConverter();

function parseBatchNumber(rawValue: string | undefined): number | null {
  const batchNumber = Number(rawValue);
  return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
}

function parseScope(rawValue: string | null): InventoryBatchResultsScope {
  return rawValue === "manual-review" ? "manual-review" : "successful";
}

function getPricedSkuResultStatus(pricedSku: PricedSku): "successful" | "manual_review" {
  const hasErrors = Boolean(pricedSku.errors && pricedSku.errors.length > 0);
  const hasPrice =
    pricedSku.price !== undefined &&
    pricedSku.price !== null &&
    pricedSku.price > 0;

  return hasPrice && !hasErrors ? "successful" : "manual_review";
}

interface SaveBatchResultsPayload {
  batchNumber: number;
  mode: InventoryBatchPricingMode;
  summary: any;
  pricedSkus: PricedSku[];
}

export async function loader({
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

    const url = new URL(request.url);
    const scope = parseScope(url.searchParams.get("scope"));
    const results = await inventoryBatchesRepository.findResults(batchNumber, scope);
    return data(results, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
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

    const payload = (await request.json()) as SaveBatchResultsPayload;

    if (payload.batchNumber !== batchNumber) {
      return data({ error: "Batch number mismatch" }, { status: 400 });
    }

    if (payload.mode !== "full" && payload.mode !== "errors") {
      return data({ error: "Invalid pricing mode" }, { status: 400 });
    }

    const rows = converter.convertFromPricedSkus(payload.pricedSkus);
    const savedBatch = await inventoryBatchesRepository.saveResults({
      batchNumber,
      mode: payload.mode,
      summary: payload.summary,
      rows: payload.pricedSkus.map((pricedSku, index) => ({
        sku: pricedSku.sku,
        resultStatus: getPricedSkuResultStatus(pricedSku),
        row: rows[index],
        errorMessages: pricedSku.errors || [],
        warningMessages: pricedSku.warnings || [],
        pricedAt: new Date(),
      })),
    });

    return data(savedBatch, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
