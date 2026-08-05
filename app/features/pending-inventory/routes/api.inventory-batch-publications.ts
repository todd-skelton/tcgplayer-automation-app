import { data } from "react-router";
import {
  inventoryBatchesRepository,
  inventoryPublicationsRepository,
} from "~/core/db";
import {
  planInventoryBatchPublication,
  previewInventoryBatchPublication,
} from "~/features/inventory-publication/services/inventoryBatchPublication.server";
import { ensureInventoryPublicationWorker } from "~/features/inventory-publication/services/inventoryPublicationWorker.server";

function parseBatchNumber(rawValue: string | undefined): number | null {
  const batchNumber = Number(rawValue);
  return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
}

export async function loader({
  params,
}: {
  params: { batchNumber?: string };
}) {
  try {
    const batchNumber = parseBatchNumber(params.batchNumber);
    if (!batchNumber) {
      return data({ error: "Invalid batch number" }, { status: 400 });
    }

    const batch =
      await inventoryBatchesRepository.findByBatchNumber(batchNumber);
    if (!batch) {
      return data(
        { error: `Batch ${batchNumber} not found` },
        { status: 404 },
      );
    }

    const publications =
      await inventoryPublicationsRepository.findByBatchNumber(batchNumber);
    const preview =
      batch.latestJob?.status === "completed"
        ? await previewInventoryBatchPublication(batchNumber)
        : null;

    return data({ preview, publications }, { status: 200 });
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

    const result = await planInventoryBatchPublication(batchNumber);
    ensureInventoryPublicationWorker();

    return data(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
