import {
  continuousPricingRepository,
  pricingConfigRepository,
} from "~/core/db";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import { normalizeServerPricingConfig } from "~/features/pricing/types/config";
import { ensureInventoryBatchPricingWorker } from "~/features/pending-inventory/services/inventoryBatchPricingWorker.server";
import type { ContinuousPricingSettings } from "../types/continuousPricing";

export async function applyContinuousPricingPolicy(
  settings: ContinuousPricingSettings,
) {
  const pricingConfig = normalizeServerPricingConfig(
    await pricingConfigRepository.get(),
  );
  const input = {
    sellerKey: settings.sellerKey,
    batchSize: settings.batchSize,
    minimumIntervalMinutes: settings.minimumIntervalMinutes,
    pricingConfig,
  };
  const result = await continuousPricingRepository.scheduleCachedPolicyBatches({
    ...input,
    pricingModelVersion: PRICING_MODEL_VERSION,
  });
  await continuousPricingRepository.scheduleDueBatch(input);
  ensureInventoryBatchPricingWorker();
  return result;
}
