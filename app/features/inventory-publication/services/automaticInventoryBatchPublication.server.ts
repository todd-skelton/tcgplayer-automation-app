import {
  inventoryBatchesRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { isAutomaticPublicationAvailable } from "../types/inventoryPublicationSettings";
import {
  planInventoryBatchPublication,
  previewInventoryBatchPublication,
} from "./inventoryBatchPublication.server";
import { ensureInventoryPublicationWorker } from "./inventoryPublicationWorker.server";

export type AutomaticInventoryBatchPublicationResult =
  | {
      planned: false;
      reason:
        | "batch_not_found"
        | "automatic_publication_unavailable"
        | "no_eligible_items";
    }
  | {
      planned: true;
      publicationId: number;
      created: boolean;
      eligibleCount: number;
    };

export async function planAutomaticInventoryBatchPublication(
  batchNumber: number,
): Promise<AutomaticInventoryBatchPublicationResult> {
  const [batch, configuration] = await Promise.all([
    inventoryBatchesRepository.findByBatchNumber(batchNumber),
    inventoryPublicationSettingsRepository.get(),
  ]);

  if (!batch) {
    return { planned: false, reason: "batch_not_found" };
  }

  if (!isAutomaticPublicationAvailable(configuration, batch.sourceType)) {
    return {
      planned: false,
      reason: "automatic_publication_unavailable",
    };
  }

  const preview = await previewInventoryBatchPublication(batchNumber, {
    policy: configuration.settings.policy,
    mode: "automatic",
  });
  if (preview.eligibleCount === 0) {
    return { planned: false, reason: "no_eligible_items" };
  }

  const result = await planInventoryBatchPublication(batchNumber, {
    policy: configuration.settings.policy,
    mode: "automatic",
  });
  ensureInventoryPublicationWorker();

  return {
    planned: true,
    publicationId: result.publication.id,
    created: result.created,
    eligibleCount: result.preview.eligibleCount,
  };
}
