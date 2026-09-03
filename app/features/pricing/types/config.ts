import { FILE_CONFIG, PRICING_CONSTANTS } from "~/core/constants/pricing";
import type { ProductLineSettings } from "~/core/types/pricing";
import type {
  ActivePricingPolicy,
  PricingPolicy,
} from "~/core/types/pricingPolicy";

export type { ActivePricingPolicy, ProductLineSettings };

/** The stored policy choice; percentile and profit-per-day read their settings elsewhere. */
export type PricingPolicyConfig =
  | { method: "percentile" }
  | Extract<PricingPolicy, { method: "target-horizon" }>
  | { method: "profit-per-day" };

export type ProfitPerDaySettings = Omit<
  Extract<PricingPolicy, { method: "profit-per-day" }>,
  "method"
>;

export interface PricingConfigSettings {
  policy: PricingPolicyConfig;
  profitPerDay: ProfitPerDaySettings;
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
};

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

export function normalizeServerPricingConfig(value: unknown): ServerPricingConfig {
  const raw = (value ?? {}) as Partial<ServerPricingConfig>;
  return {
    pricing: {
      ...DEFAULT_PRICING_CONFIG,
      ...(raw.pricing ?? {}),
      policy: normalizePricingPolicy(raw.pricing?.policy),
      profitPerDay: normalizeProfitPerDaySettings(raw.pricing?.profitPerDay),
      successRateThreshold: {
        ...DEFAULT_PRICING_CONFIG.successRateThreshold,
        ...(raw.pricing?.successRateThreshold ?? {}),
      },
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
