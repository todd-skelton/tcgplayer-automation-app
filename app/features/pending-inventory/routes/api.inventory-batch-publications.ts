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
    if (request.method === "PATCH") {
      const body = (await request.json()) as Record<string, unknown>;
      const publicationId = Number(body.publicationId);
      const itemId = Number(body.itemId);
      const confirmedQuantity = Number(body.confirmedQuantity);
      const sellerKey =
        typeof body.sellerKey === "string" ? body.sellerKey.trim() : "";
      const confirmedAt =
        typeof body.confirmedAt === "string"
          ? new Date(body.confirmedAt)
          : new Date(Number.NaN);
      const evidence = body.evidence;
      if (
        body.operation !== "confirm-ambiguous-item" ||
        !Number.isSafeInteger(publicationId) ||
        publicationId <= 0 ||
        !Number.isSafeInteger(itemId) ||
        itemId <= 0 ||
        !Number.isInteger(confirmedQuantity) ||
        confirmedQuantity <= 0 ||
        !sellerKey ||
        Number.isNaN(confirmedAt.getTime()) ||
        confirmedAt > new Date() ||
        !evidence ||
        typeof evidence !== "object" ||
        Array.isArray(evidence) ||
        Object.keys(evidence).length === 0
      ) {
        return data(
          { error: "A valid ambiguous confirmation is required" },
          { status: 400 },
        );
      }

      const publication =
        await inventoryPublicationsRepository.findById(publicationId);
      const item = publication?.items.find((candidate) => candidate.id === itemId);
      if (
        !publication ||
        publication.batchNumber !== batchNumber ||
        publication.sourceType !== "pending_inventory" ||
        publication.sellerKey !== sellerKey ||
        !item ||
        item.status !== "ambiguous" ||
        item.quantityDelta !== confirmedQuantity
      ) {
        return data(
          { error: "Confirmation does not match the ambiguous publication item" },
          { status: 409 },
        );
      }

      await inventoryPublicationsRepository.saveItemOutcomes(publicationId, [
        {
          itemId,
          status: "published",
          confirmedAt,
          confirmationEvidence: evidence as Record<string, unknown>,
        },
      ]);
      await inventoryPublicationsRepository.recoverPublicationsWithSavedOutcomes();
      return data(
        await inventoryPublicationsRepository.findById(publicationId),
        { status: 200 },
      );
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
