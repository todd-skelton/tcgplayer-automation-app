import { FILE_CONFIG, PRICING_CONSTANTS } from "~/core/constants/pricing";
import type { PricingConfig, ProductLineSettings } from "~/core/types/pricing";
import type {
  ActivePricingPolicy,
  ForecastCorrection,
  PricingPolicy,
} from "~/core/types/pricingPolicy";
import {
  SHIPPING_THRESHOLDS,
  type ShippingCostModel,
} from "~/core/types/shippingThresholds";

export type { ActivePricingPolicy, ProductLineSettings };

/** The stored policy choice; percentile and profit-per-day read their settings elsewhere. */
export type PricingPolicyConfig =
  | { method: "percentile" }
  | Extract<PricingPolicy, { method: "target-horizon" }>
  | { method: "profit-per-day" };

export type ProfitPerDaySettings = Omit<
  Extract<PricingPolicy, { method: "profit-per-day" }>,
  "method" | "forecastCorrection" | "shippingThresholdSnap"
>;

/** Listing just under the shipping thresholds when the learned shipping costs make it pay. */
export interface ShippingThresholdSnapSettings {
  enabled: boolean;
  /** Thresholds to consider listing one cent under. */
  thresholds: number[];
  /** A price up to this fraction above a threshold may be snapped just under it. */
  snapRange: number;
  /** Trailing days of orders the shipping cost model learns from. */
  evidenceWindowDays: number;
}

export const SHIPPING_EVIDENCE_WINDOW_DAYS = [30, 60, 90, 180, 365] as const;

export const DEFAULT_SHIPPING_THRESHOLD_SNAP_SETTINGS: ShippingThresholdSnapSettings = {
  enabled: true,
  thresholds: [...SHIPPING_THRESHOLDS],
  snapRange: 0.1,
  evidenceWindowDays: 90,
};

export const isValidSnapRange = (value: number): boolean =>
  value > 0 && value <= 0.5;

/** Correcting the curve's sell-time forecasts by how the seller's own listings have sold. */
export interface ForecastCorrectionSettings {
  enabled: boolean;
  /** Trailing days of listings and sales the correction learns from. */
  evidenceWindowDays: number;
}

export const FORECAST_EVIDENCE_WINDOW_DAYS = [28, 56, 84] as const;

export const DEFAULT_FORECAST_CORRECTION_SETTINGS: ForecastCorrectionSettings = {
  enabled: false,
  evidenceWindowDays: 56,
};

export interface PricingConfigSettings {
  policy: PricingPolicyConfig;
  profitPerDay: ProfitPerDaySettings;
  /** Applies to the profit-per-day policy. */
  shippingThresholdSnaps: ShippingThresholdSnapSettings;
  defaultPercentile: number;
  percentileStep: number;
  minPercentile: number;
  maxPercentile: number;
  skipPrefix: string;
  minPriceMultiplier: number;
  minPriceConstant: number;
  successRateThreshold: {
    low: number;
    high: number;
  };
  /** Applies to the target-horizon and profit-per-day policies. */
  forecastCorrection: ForecastCorrectionSettings;
}

export interface SupplyAnalysisConfig {
  enableSupplyAnalysis: boolean;
  includeUnverifiedSellers: boolean;
}

export interface FileConfig {
  accept: string;
  outputPrefix: string;
  mimeType: string;
}

export interface FormDefaults {
  percentile: number;
  sellerKey: string;
}

export interface ProductLinePricingConfig {
  productLineSettings: Record<number, ProductLineSettings>;
  defaultPercentile: number;
}

export interface ServerPricingConfig {
  pricing: PricingConfigSettings;
  supplyAnalysis: SupplyAnalysisConfig;
  productLinePricing: ProductLinePricingConfig;
}

export const DEFAULT_PROFIT_PER_DAY_SETTINGS: ProfitPerDaySettings = {
  dailyReturnHurdle: 0.005,
  relativeOverhead: 0.15,
  staticOverheadPerUnit: 0.3,
};

export const DEFAULT_PRICING_CONFIG: PricingConfigSettings = {
  policy: { method: "percentile" },
  profitPerDay: DEFAULT_PROFIT_PER_DAY_SETTINGS,
  shippingThresholdSnaps: DEFAULT_SHIPPING_THRESHOLD_SNAP_SETTINGS,
  defaultPercentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
  percentileStep: PRICING_CONSTANTS.PERCENTILE_STEP,
  minPercentile: PRICING_CONSTANTS.MIN_PERCENTILE,
  maxPercentile: PRICING_CONSTANTS.MAX_PERCENTILE,
  skipPrefix: PRICING_CONSTANTS.SKIP_PREFIX,
  minPriceMultiplier: PRICING_CONSTANTS.MIN_PRICE_MULTIPLIER,
  minPriceConstant: PRICING_CONSTANTS.MIN_PRICE_CONSTANT,
  successRateThreshold: {
    low: PRICING_CONSTANTS.SUCCESS_RATE_THRESHOLD.LOW,
    high: PRICING_CONSTANTS.SUCCESS_RATE_THRESHOLD.HIGH,
  },
  forecastCorrection: DEFAULT_FORECAST_CORRECTION_SETTINGS,
};

/**
 * Forecast correction settings from stored config. Configs saved before
 * corrections were learned from recent sales read as the defaults.
 */
export function normalizeForecastCorrectionSettings(
  value: unknown,
): ForecastCorrectionSettings {
  const raw = (value ?? {}) as Partial<Record<keyof ForecastCorrectionSettings, unknown>>;
  const defaults = DEFAULT_FORECAST_CORRECTION_SETTINGS;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    evidenceWindowDays: FORECAST_EVIDENCE_WINDOW_DAYS.find(
      (days) => days === raw.evidenceWindowDays,
    ) ?? defaults.evidenceWindowDays,
  };
}

export const DEFAULT_SUPPLY_ANALYSIS_CONFIG: SupplyAnalysisConfig = {
  enableSupplyAnalysis: true,
  includeUnverifiedSellers: false,
};

export const DEFAULT_PRODUCT_LINE_PRICING_CONFIG: ProductLinePricingConfig = {
  productLineSettings: {},
  defaultPercentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
};

export const DEFAULT_SERVER_PRICING_CONFIG: ServerPricingConfig = {
  pricing: DEFAULT_PRICING_CONFIG,
  supplyAnalysis: DEFAULT_SUPPLY_ANALYSIS_CONFIG,
  productLinePricing: DEFAULT_PRODUCT_LINE_PRICING_CONFIG,
};

function normalizePricingPolicy(value: unknown): PricingPolicyConfig {
  if (
    value &&
    typeof value === "object" &&
    "method" in value &&
    value.method === "target-horizon" &&
    "horizonDays" in value &&
    typeof value.horizonDays === "number" &&
    Number.isFinite(value.horizonDays) &&
    value.horizonDays > 0
  ) {
    return { method: "target-horizon", horizonDays: value.horizonDays };
  }
  if (
    value &&
    typeof value === "object" &&
    "method" in value &&
    value.method === "profit-per-day"
  ) {
    return { method: "profit-per-day" };
  }
  return { method: "percentile" };
}

/** Values each profit-per-day setting accepts; its form applies the same rules. */
export const isValidProfitPerDaySetting: Record<
  keyof ProfitPerDaySettings,
  (value: number) => boolean
> = {
  dailyReturnHurdle: (value) => value > 0 && value < 1,
  relativeOverhead: (value) => value >= 0 && value < 1,
  staticOverheadPerUnit: (value) => value >= 0,
};

function normalizeProfitPerDaySettings(value: unknown): ProfitPerDaySettings {
  const raw = (value ?? {}) as Partial<
    Record<keyof ProfitPerDaySettings, unknown>
  >;
  const settings = { ...DEFAULT_PROFIT_PER_DAY_SETTINGS };
  const keys = Object.keys(settings) as Array<keyof ProfitPerDaySettings>;
  for (const key of keys) {
    const candidate = raw[key];
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      isValidProfitPerDaySetting[key](candidate)
    ) {
      settings[key] = candidate;
    }
  }
  return settings;
}

/**
 * Snap settings from stored config. Pricing jobs keep the config they were
 * queued with, so configs saved before snaps existed read as the defaults.
 */
export function normalizeShippingThresholdSnapSettings(
  value: unknown,
): ShippingThresholdSnapSettings {
  const raw = (value ?? {}) as Partial<Record<keyof ShippingThresholdSnapSettings, unknown>>;
  const defaults = DEFAULT_SHIPPING_THRESHOLD_SNAP_SETTINGS;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
    thresholds: Array.isArray(raw.thresholds)
      ? SHIPPING_THRESHOLDS.filter((threshold) =>
          (raw.thresholds as unknown[]).includes(threshold),
        )
      : defaults.thresholds,
    snapRange:
      typeof raw.snapRange === "number" && Number.isFinite(raw.snapRange) &&
      isValidSnapRange(raw.snapRange)
        ? raw.snapRange
        : defaults.snapRange,
    evidenceWindowDays: SHIPPING_EVIDENCE_WINDOW_DAYS.find(
      (days) => days === raw.evidenceWindowDays,
    ) ?? defaults.evidenceWindowDays,
  };
}

function normalizeProductLineSettings(
  value: unknown,
): Record<number, ProductLineSettings> {
  const entries = Object.entries(
    (value ?? {}) as Record<string, ProductLineSettings | null>,
  );
  return Object.fromEntries(
    entries.flatMap(([productLineId, rawSettings]) => {
      if (!rawSettings) return [];
      const { dailyReturnHurdle, ...settings } = rawSettings;
      return [
        [
          productLineId,
          !settings.skip &&
          typeof dailyReturnHurdle === "number" &&
          Number.isFinite(dailyReturnHurdle) &&
          isValidProfitPerDaySetting.dailyReturnHurdle(dailyReturnHurdle)
            ? { ...settings, dailyReturnHurdle }
            : settings,
        ],
      ];
    }),
  );
}

/** The profit-per-day policy with its settings. */
export function profitPerDayPolicy(
  settings: ProfitPerDaySettings,
): Extract<PricingPolicy, { method: "profit-per-day" }> {
  return { method: "profit-per-day", ...settings };
}

/** The stored policy choice with the settings its method needs. */
export function activePricingPolicy(
  settings: PricingConfigSettings,
): ActivePricingPolicy {
  return settings.policy.method === "profit-per-day"
    ? profitPerDayPolicy(settings.profitPerDay)
    : settings.policy;
}

/** True when pricing under these settings would apply a learned forecast correction. */
export function correctsForecasts(settings: PricingConfigSettings): boolean {
  return settings.policy.method !== "percentile" &&
    normalizeForecastCorrectionSettings(settings.forecastCorrection).enabled;
}

/** The active policy as it applies to one product line, honoring its hurdle. */
export function productLinePricingPolicy<Policy extends ActivePricingPolicy>(
  policy: Policy,
  settings: ProductLineSettings | undefined,
): Policy {
  return policy.method === "profit-per-day" &&
    settings?.dailyReturnHurdle !== undefined
    ? { ...policy, dailyReturnHurdle: settings.dailyReturnHurdle }
    : policy;
}

/**
 * The calculator settings every pricing run derives from the stored config:
 * the active policy, the price floor, supply analysis, per-product-line
 * percentiles, and shipping threshold snaps when a learned shipping cost
 * model is supplied. Callers add their own resolver, progress, and cancellation.
 */
/** True when pricing under these settings would consider threshold snaps. */
export function snapsShippingThresholds(settings: PricingConfigSettings): boolean {
  const snaps = normalizeShippingThresholdSnapSettings(settings.shippingThresholdSnaps);
  return settings.policy.method === "profit-per-day" && snaps.enabled &&
    snaps.thresholds.length > 0;
}

export function pricingCalculatorConfig(
  config: ServerPricingConfig,
  options: {
    excludedSellerKey?: string;
    shippingCostModel?: ShippingCostModel;
    forecastCorrection?: ForecastCorrection;
  } = {},
): Pick<
  PricingConfig,
  | "percentile"
  | "policy"
  | "minPriceMultiplier"
  | "minPriceConstant"
  | "enableSupplyAnalysis"
  | "supplyAnalysisConfig"
  | "productLinePricingConfig"
> {
  const policy = activePricingPolicy(config.pricing);
  // A correction describes how one seller's listings sell, so it applies
  // only when pricing that seller's inventory or intake bound for it.
  const correction = options.forecastCorrection &&
    correctsForecasts(config.pricing) &&
    (!options.excludedSellerKey || options.forecastCorrection.sellerKey === options.excludedSellerKey)
    ? options.forecastCorrection
    : undefined;
  const sellerBoundPolicy = policy.method !== "percentile" && correction
    ? { ...policy, forecastCorrection: correction }
    : policy;
  const snaps = normalizeShippingThresholdSnapSettings(
    config.pricing.shippingThresholdSnaps,
  );
  const snappingPolicy =
    sellerBoundPolicy.method === "profit-per-day" && snaps.enabled &&
    snaps.thresholds.length > 0 && options.shippingCostModel
      ? {
          ...sellerBoundPolicy,
          shippingThresholdSnap: {
            thresholds: snaps.thresholds,
            snapRange: snaps.snapRange,
            costModel: options.shippingCostModel,
          },
        }
      : sellerBoundPolicy;
  return {
    percentile: config.productLinePricing.defaultPercentile,
    policy: snappingPolicy,
    minPriceMultiplier: config.pricing.minPriceMultiplier,
    minPriceConstant: config.pricing.minPriceConstant,
    enableSupplyAnalysis: config.supplyAnalysis.enableSupplyAnalysis,
    supplyAnalysisConfig: {
      includeUnverifiedSellers: config.supplyAnalysis.includeUnverifiedSellers,
      excludedSellerKey: options.excludedSellerKey,
    },
    productLinePricingConfig: config.productLinePricing,
  };
}

export function normalizeServerPricingConfig(value: unknown): ServerPricingConfig {
  const raw = (value ?? {}) as Partial<ServerPricingConfig>;
  return {
    pricing: {
      ...DEFAULT_PRICING_CONFIG,
      ...(raw.pricing ?? {}),
      policy: normalizePricingPolicy(raw.pricing?.policy),
      profitPerDay: normalizeProfitPerDaySettings(raw.pricing?.profitPerDay),
      shippingThresholdSnaps: normalizeShippingThresholdSnapSettings(
        raw.pricing?.shippingThresholdSnaps,
      ),
      successRateThreshold: {
        ...DEFAULT_PRICING_CONFIG.successRateThreshold,
        ...(raw.pricing?.successRateThreshold ?? {}),
      },
      forecastCorrection: normalizeForecastCorrectionSettings(raw.pricing?.forecastCorrection),
    },
    supplyAnalysis: {
      ...DEFAULT_SUPPLY_ANALYSIS_CONFIG,
      ...(raw.supplyAnalysis ?? {}),
    },
    productLinePricing: {
      ...DEFAULT_PRODUCT_LINE_PRICING_CONFIG,
      ...(raw.productLinePricing ?? {}),
      productLineSettings: normalizeProductLineSettings(
        raw.productLinePricing?.productLineSettings,
      ),
    },
  };
}

export const DEFAULT_FILE_CONFIG: FileConfig = {
  accept: FILE_CONFIG.ACCEPT,
  outputPrefix: FILE_CONFIG.OUTPUT_PREFIX,
  mimeType: FILE_CONFIG.MIME_TYPE,
};

export const DEFAULT_FORM_DEFAULTS: FormDefaults = {
  percentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
  sellerKey: "",
};
