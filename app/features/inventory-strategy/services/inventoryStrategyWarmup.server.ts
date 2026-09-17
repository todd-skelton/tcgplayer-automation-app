import {
  inventoryPublicationSettingsRepository,
  pricingConfigRepository,
} from "~/core/db";
import { loadInventoryStrategyDashboard } from "./inventoryStrategyDashboard.server";

/**
 * Starts rebuilding the strategy page's dashboard for the continuously
 * priced seller, so the next page load finds it ready.
 */
export async function warmInventoryStrategy(): Promise<void> {
  const [publication, pricingConfig] = await Promise.all([
    inventoryPublicationSettingsRepository.get(),
    pricingConfigRepository.get(),
  ]);
  const { sellerKey } = publication.settings.continuousPricing;
  if (!sellerKey) return;
  await loadInventoryStrategyDashboard(sellerKey, pricingConfig);
}
