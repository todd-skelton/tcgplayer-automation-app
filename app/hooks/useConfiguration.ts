import { useLocalStorageState } from "./useLocalStorageState";
import { PRICING_CONSTANTS, FILE_CONFIG } from "../constants/pricing";

// Configuration interfaces
export interface PricingConfig {
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

export interface FileConfig {
  accept: string;
  outputPrefix: string;
  mimeType: string;
}

export interface FormDefaults {
  percentile: number;
  sellerKey: string;
}

export interface AppConfiguration {
  pricing: PricingConfig;
  file: FileConfig;
  formDefaults: FormDefaults;
}

// Default configuration based on existing constants
const DEFAULT_CONFIG: AppConfiguration = {
  pricing: {
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
  },
  file: {
    accept: FILE_CONFIG.ACCEPT,
    outputPrefix: FILE_CONFIG.OUTPUT_PREFIX,
    mimeType: FILE_CONFIG.MIME_TYPE,
  },
  formDefaults: {
    percentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
    sellerKey: "",
  },
};

export function useConfiguration() {
  const [config, setConfig] = useLocalStorageState<AppConfiguration>(
    "tcgplayer-automation-config",
    DEFAULT_CONFIG
  );

  // Helper functions for updating specific parts of the configuration
  const updatePricingConfig = (updates: Partial<PricingConfig>) => {
    setConfig((prev) => ({
      ...prev,
      pricing: { ...prev.pricing, ...updates },
    }));
  };

  const updateFileConfig = (updates: Partial<FileConfig>) => {
    setConfig((prev) => ({
      ...prev,
      file: { ...prev.file, ...updates },
    }));
  };

  const updateFormDefaults = (updates: Partial<FormDefaults>) => {
    setConfig((prev) => ({
      ...prev,
      formDefaults: { ...prev.formDefaults, ...updates },
    }));
  };

  // Reset to defaults
  const resetToDefaults = () => {
    setConfig(DEFAULT_CONFIG);
  };

  // Computed values
  const percentiles = Array.from(
    {
      length: Math.floor(
        (config.pricing.maxPercentile - config.pricing.minPercentile) /
          config.pricing.percentileStep +
          1
      ),
    },
    (_, i) => config.pricing.minPercentile + i * config.pricing.percentileStep
  );

  return {
    config,
    setConfig,
    updatePricingConfig,
    updateFileConfig,
    updateFormDefaults,
    resetToDefaults,
    percentiles,
    // Backward compatibility helpers
    PRICING_CONSTANTS: config.pricing,
    FILE_CONFIG: config.file,
  };
}

// Hook for just form defaults (lighter weight)
export function useFormDefaults() {
  const [formDefaults, setFormDefaults] = useLocalStorageState<FormDefaults>(
    "tcgplayer-form-defaults",
    DEFAULT_CONFIG.formDefaults
  );

  const updatePercentile = (percentile: number) => {
    setFormDefaults((prev) => ({ ...prev, percentile }));
  };

  const updateSellerKey = (sellerKey: string) => {
    setFormDefaults((prev) => ({ ...prev, sellerKey }));
  };

  return {
    formDefaults,
    setFormDefaults,
    updatePercentile,
    updateSellerKey,
  };
}
