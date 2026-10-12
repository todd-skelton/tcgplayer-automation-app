import {
  forecastCalibrationEvidenceRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import {
  learnForecastCalibration,
  type ForecastCalibrationReport,
} from "../domain/forecastCalibrationModel";

const DAY_MS = 86_400_000;
/** Sales can't be read as missing when the order history is older than this. */
const MAXIMUM_ORDER_HISTORY_AGE_MS = 2 * DAY_MS;

/**
 * How the continuous pricing seller's listings sold against their sell-time
 * forecasts over the trailing window, ending where the latest complete order
 * history sync ends.
 */
export async function loadForecastCalibration(
  evidenceWindowDays: number,
  now = new Date(),
): Promise<ForecastCalibrationReport> {
  const configuration = await inventoryPublicationSettingsRepository.get();
  const sellerKey = configuration.settings.continuousPricing.sellerKey?.trim() ?? "";
  if (!sellerKey) throw new Error("Set the continuous pricing seller to calibrate sell-time forecasts.");
  const coverage = await forecastCalibrationEvidenceRepository.findOrderHistoryCoverage(sellerKey);
  if (!coverage) throw new Error("Forecast calibration needs a complete order history sync.");
  if (now.getTime() - coverage.coveredThrough.getTime() > MAXIMUM_ORDER_HISTORY_AGE_MS) {
    throw new Error(
      `Order history was last synced through ${coverage.coveredThrough.toISOString()}; forecast calibration waits for a current sync.`,
    );
  }
  const through = new Date(Math.min(now.getTime(), coverage.coveredThrough.getTime()));
  const from = new Date(
    Math.max(through.getTime() - evidenceWindowDays * DAY_MS, coverage.coveredFrom.getTime()),
  );
  const [prices, sales] = await Promise.all([
    forecastCalibrationEvidenceRepository.findListedPrices(sellerKey, from, through, PRICING_MODEL_VERSION),
    forecastCalibrationEvidenceRepository.findSkuSales(sellerKey, from, through),
  ]);
  return learnForecastCalibration({ sellerKey, prices, sales, from, through, learnedAt: now, evidenceWindowDays });
}
