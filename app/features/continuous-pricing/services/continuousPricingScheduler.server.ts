import {
  continuousPricingRepository,
  inventoryPublicationSettingsRepository,
  pricingConfigRepository,
} from "~/core/db";
import { ensureInventoryBatchPricingWorker } from "~/features/pending-inventory/services/inventoryBatchPricingWorker.server";
import { refreshContinuousPricingInventory } from "./continuousInventoryRefresh.server";

export type ContinuousPricingSchedulerResult =
  | { status: "disabled" | "refresh_failed" | "idle" }
  | {
      status: "scheduled";
      batchNumber: number;
      itemCount: number;
    };

export async function runContinuousPricingSchedulerCycle(): Promise<ContinuousPricingSchedulerResult> {
  const publicationConfiguration =
    await inventoryPublicationSettingsRepository.get();
  const settings = publicationConfiguration.settings.continuousPricing;
  if (!settings.enabled || !settings.sellerKey) {
    return { status: "disabled" };
  }

  const shouldRefresh = await continuousPricingRepository.shouldRefresh(
    settings.sellerKey,
    settings.inventoryRefreshMinutes,
  );
  if (shouldRefresh) {
    try {
      await refreshContinuousPricingInventory(settings.sellerKey);
    } catch (error) {
      await continuousPricingRepository.recordRefreshFailure(
        settings.sellerKey,
        error instanceof Error ? error.message : String(error),
      );
      return { status: "refresh_failed" };
    }
  }

  const pricingConfig = await pricingConfigRepository.get();
  const scheduled = await continuousPricingRepository.scheduleDueBatch({
    sellerKey: settings.sellerKey,
    batchSize: settings.batchSize,
    minimumIntervalMinutes: settings.minimumIntervalMinutes,
    pricingConfig: {
      pricing: pricingConfig.pricing,
      supplyAnalysis: pricingConfig.supplyAnalysis,
      productLinePricing: pricingConfig.productLinePricing,
    },
  });
  if (!scheduled) {
    return { status: "idle" };
  }

  ensureInventoryBatchPricingWorker();
  return { status: "scheduled", ...scheduled };
}
