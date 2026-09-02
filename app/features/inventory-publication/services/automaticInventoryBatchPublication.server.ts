import { isDeepStrictEqual } from "node:util";
import { normalizeServerPricingConfig } from "~/features/pricing/types/config";
import {
  inventoryBatchesRepository,
  inventoryPublicationSettingsRepository,
  pricingConfigRepository,
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
        | "superseded_pricing_config"
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

  if (batch.sourceType === "strategy") {
    return {
      planned: false,
      reason: "automatic_publication_unavailable",
    };
  }

  if (batch.sourceType === "continuous" && batch.latestJob) {
    const currentConfig = await pricingConfigRepository.get();
    if (
      !isDeepStrictEqual(
        normalizeServerPricingConfig(batch.latestJob.config),
        normalizeServerPricingConfig(currentConfig),
      )
    ) {
      return { planned: false, reason: "superseded_pricing_config" };
    }
  }

  if (!isAutomaticPublicationAvailable(configuration, batch.sourceType)) {
    return {
      planned: false,
      reason: "automatic_publication_unavailable",
    };
  }

  if (batch.successfulCount === 0) {
    return { planned: false, reason: "no_eligible_items" };
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
    targetSellerKey:
      configuration.settings.continuousPricing.sellerKey || undefined,
  });
  ensureInventoryPublicationWorker();

  return {
    planned: true,
    publicationId: result.publication.id,
    created: result.created,
    eligibleCount: result.preview.eligibleCount,
  };
}
