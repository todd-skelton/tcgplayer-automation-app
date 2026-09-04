import {
  inventoryPublicationSettingsRepository,
  pricingConfigRepository,
} from "~/core/db";
import { loadForecastGrading } from "./forecastGrading.server";
import { loadInventoryStrategyDashboard } from "./inventoryStrategyDashboard.server";

/**
 * Starts rebuilding the strategy page's dashboard and forecast grading for
 * the continuously priced seller, so the next page load finds them ready.
 */
export async function warmInventoryStrategy(): Promise<void> {
  const [publication, pricingConfig] = await Promise.all([
    inventoryPublicationSettingsRepository.get(),
    pricingConfigRepository.get(),
  ]);
  const { sellerKey } = publication.settings.continuousPricing;
  if (!sellerKey) return;
  await Promise.all([
    loadInventoryStrategyDashboard(sellerKey, pricingConfig),
    loadForecastGrading(sellerKey),
  ]);
}
