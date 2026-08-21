import { data } from "react-router";
import {
  inventoryBatchesRepository,
  inventoryPublicationSettingsRepository,
  inventoryPublicationsRepository,
} from "~/core/db";
import {
  planInventoryBatchPublications,
  previewInventoryBatchPublication,
} from "~/features/inventory-publication/services/inventoryBatchPublication.server";
import { ensureInventoryPublicationWorker } from "~/features/inventory-publication/services/inventoryPublicationWorker.server";

function parseBatchNumber(rawValue: string | undefined): number | null {
  const batchNumber = Number(rawValue);
  return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
}

export async function loader({ params }: { params: { batchNumber?: string } }) {
  try {
    const batchNumber = parseBatchNumber(params.batchNumber);
    if (!batchNumber) {
      return data({ error: "Invalid batch number" }, { status: 400 });
    }

    const batch =
      await inventoryBatchesRepository.findByBatchNumber(batchNumber);
    if (!batch) {
      return data({ error: `Batch ${batchNumber} not found` }, { status: 404 });
    }

    const [publications, configuration] = await Promise.all([
      inventoryPublicationsRepository.findByBatchNumber(batchNumber),
      inventoryPublicationSettingsRepository.get(),
    ]);
    const preview =
      batch.latestJob?.status === "completed"
        ? await previewInventoryBatchPublication(batchNumber, {
            policy: configuration.settings.policy,
          })
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

    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      // An empty body preserves the existing publish-all behavior.
    }
    const selectedSkus =
      body && typeof body === "object" && "selectedSkus" in body
        ? (body as { selectedSkus?: unknown }).selectedSkus
        : undefined;
    if (
      selectedSkus !== undefined &&
      (!Array.isArray(selectedSkus) ||
        selectedSkus.some((sku) => !Number.isInteger(sku) || Number(sku) <= 0))
    ) {
      return data(
        { error: "selectedSkus must contain valid SKU numbers" },
        { status: 400 },
      );
    }

    const configuration = await inventoryPublicationSettingsRepository.get();
    const result = await planInventoryBatchPublications(batchNumber, {
      policy: configuration.settings.policy,
      selectedSkus: selectedSkus as number[] | undefined,
      targetSellerKey:
        configuration.settings.continuousPricing.sellerKey || undefined,
    });
    ensureInventoryPublicationWorker();

    return data(result, { status: result.createdCount > 0 ? 201 : 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
