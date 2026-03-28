import { FILE_CONFIG, PRICING_CONSTANTS } from "~/core/constants/pricing";

export interface PricingConfigSettings {
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
  maxListingsPerSku: number;
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

export interface ProductLineSettings {
  percentile: number;
  skip: boolean;
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

export const DEFAULT_PRICING_CONFIG: PricingConfigSettings = {
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
  maxListingsPerSku: 200,
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

export const DEFAULT_FILE_CONFIG: FileConfig = {
  accept: FILE_CONFIG.ACCEPT,
  outputPrefix: FILE_CONFIG.OUTPUT_PREFIX,
  mimeType: FILE_CONFIG.MIME_TYPE,
};

export const DEFAULT_FORM_DEFAULTS: FormDefaults = {
  percentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
  sellerKey: "",
};
