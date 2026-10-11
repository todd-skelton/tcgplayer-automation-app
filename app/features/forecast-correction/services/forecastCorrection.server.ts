import {
  forecastCorrectionEvidenceRepository,
  inventoryPublicationSettingsRepository,
} from "~/core/db";
import { PRICING_MODEL_VERSION, type ForecastCorrection } from "~/core/types/pricingPolicy";
import {
  correctsForecasts,
  normalizeForecastCorrectionSettings,
  type PricingConfigSettings,
} from "~/features/pricing/types/config";
import {
  learnForecastCorrection,
  type ForecastCorrectionReport,
} from "../domain/forecastCorrectionModel";

const DAY_MS = 86_400_000;
/** Pricing runs reuse a learned correction this long before learning it again. */
const CORRECTION_REUSE_MS = 60 * 60 * 1000;
/** Sales can't be read as missing when the order history is older than this. */
const MAXIMUM_ORDER_HISTORY_AGE_MS = 2 * DAY_MS;

const learnedCorrections = new Map<string, { learnedAt: number; correction: Promise<ForecastCorrection | undefined> }>();

/** The seller continuous pricing lists for, whose sales corrections learn from. */
async function correctionSellerKey(): Promise<string> {
  const configuration = await inventoryPublicationSettingsRepository.get();
  return configuration.settings.continuousPricing.sellerKey?.trim() ?? "";
}

/** Learns a forecast correction from the seller's listings and sales over the trailing window. */
export async function learnRecentForecastCorrection(
  sellerKey: string,
  evidenceWindowDays: number,
  now = new Date(),
): Promise<ForecastCorrectionReport> {
  const coverage = await forecastCorrectionEvidenceRepository.findOrderHistoryCoverage(sellerKey);
  if (!coverage) throw new Error("Forecast corrections need a complete order history sync.");
  if (now.getTime() - coverage.coveredThrough.getTime() > MAXIMUM_ORDER_HISTORY_AGE_MS) {
    throw new Error(
      `Order history was last synced through ${coverage.coveredThrough.toISOString()}; forecast corrections wait for a current sync.`,
    );
  }
  const through = new Date(Math.min(now.getTime(), coverage.coveredThrough.getTime()));
  const from = new Date(
    Math.max(through.getTime() - evidenceWindowDays * DAY_MS, coverage.coveredFrom.getTime()),
  );
  const [prices, sales] = await Promise.all([
    forecastCorrectionEvidenceRepository.findListedPrices(sellerKey, from, through, PRICING_MODEL_VERSION),
    forecastCorrectionEvidenceRepository.findSkuSales(sellerKey, from, through),
  ]);
  return learnForecastCorrection({ sellerKey, prices, sales, from, through, learnedAt: now, evidenceWindowDays });
}

/**
 * The forecast correction pricing applies, relearned at most hourly. Pricing
 * goes ahead uncorrected when corrections are off, the policy is percentile,
 * no continuous pricing seller is set, nothing passed its held-out check, or
 * the correction cannot be learned; a failure waits out the hour too.
 */
export async function forecastCorrectionForPricing(
  pricing: PricingConfigSettings,
  now = new Date(),
): Promise<ForecastCorrection | undefined> {
  if (!correctsForecasts(pricing)) return undefined;
  const settings = normalizeForecastCorrectionSettings(pricing.forecastCorrection);
  let sellerKey: string;
  try {
    sellerKey = await correctionSellerKey();
  } catch (error) {
    console.error("Forecast correction seller could not be read; pricing without it.", error);
    return undefined;
  }
  if (!sellerKey) return undefined;
  const key = `${sellerKey}:${settings.evidenceWindowDays}`;
  const cached = learnedCorrections.get(key);
  if (cached && now.getTime() - cached.learnedAt < CORRECTION_REUSE_MS) return cached.correction;
  const correction = learnRecentForecastCorrection(sellerKey, settings.evidenceWindowDays, now).then(
    (report) => report.correction ?? undefined,
    (error) => {
      console.error("Forecast correction could not be learned; pricing without it for the next hour.", error);
      return undefined;
    },
  );
  learnedCorrections.set(key, { learnedAt: now.getTime(), correction });
  return correction;
}

/** What the correction learned over a window, and whether pricing applies it. */
export interface ForecastCorrectionStatus {
  report: ForecastCorrectionReport;
  /** Corrections are on, the policy uses sell-time forecasts, and this window is the one pricing learns from. */
  appliedToPricing: boolean;
}

export async function loadForecastCorrectionStatus(
  pricing: PricingConfigSettings,
  evidenceWindowDays: number,
  now = new Date(),
): Promise<ForecastCorrectionStatus> {
  const sellerKey = await correctionSellerKey();
  if (!sellerKey) throw new Error("Set the continuous pricing seller to learn forecast corrections.");
  const settings = normalizeForecastCorrectionSettings(pricing.forecastCorrection);
  const report = await learnRecentForecastCorrection(sellerKey, evidenceWindowDays, now);
  return {
    report,
    appliedToPricing:
      correctsForecasts(pricing) &&
      settings.evidenceWindowDays === evidenceWindowDays &&
      report.correction !== null,
  };
}
