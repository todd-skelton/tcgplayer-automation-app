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

// Default configurations
const DEFAULT_PRICING_CONFIG: PricingConfig = {
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

const DEFAULT_SUPPLY_ANALYSIS_CONFIG: SupplyAnalysisConfig = {
  enableSupplyAnalysis: false, // Disabled by default due to network overhead
  maxListingsPerSku: 200, // Reasonable limit for performance
  includeUnverifiedSellers: false, // Quality over quantity
};

const DEFAULT_FILE_CONFIG: FileConfig = {
  accept: FILE_CONFIG.ACCEPT,
  outputPrefix: FILE_CONFIG.OUTPUT_PREFIX,
  mimeType: FILE_CONFIG.MIME_TYPE,
};

const DEFAULT_FORM_DEFAULTS: FormDefaults = {
  percentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
  sellerKey: "",
};

// Individual configuration hooks
export function usePricingConfig() {
  const [config, setConfig] = useLocalStorageState<PricingConfig>(
    "tcgplayer-pricing-config",
    DEFAULT_PRICING_CONFIG
  );

  const updateConfig = (updates: Partial<PricingConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_PRICING_CONFIG);
  };

  // Computed values
  const percentiles = Array.from(
    {
      length: Math.floor(
        (config.maxPercentile - config.minPercentile) / config.percentileStep +
          1
      ),
    },
    (_, i) => config.minPercentile + i * config.percentileStep
  );

  return {
    config,
    setConfig,
    updateConfig,
    resetToDefaults,
    percentiles,
    // Backward compatibility
    PRICING_CONSTANTS: config,
  };
}

export function useSupplyAnalysisConfig() {
  const [config, setConfig] = useLocalStorageState<SupplyAnalysisConfig>(
    "tcgplayer-supply-analysis-config",
    DEFAULT_SUPPLY_ANALYSIS_CONFIG
  );

  const updateConfig = (updates: Partial<SupplyAnalysisConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_SUPPLY_ANALYSIS_CONFIG);
  };

  return {
    config,
    setConfig,
    updateConfig,
    resetToDefaults,
  };
}

export function useFileConfig() {
  const [config, setConfig] = useLocalStorageState<FileConfig>(
    "tcgplayer-file-config",
    DEFAULT_FILE_CONFIG
  );

  const updateConfig = (updates: Partial<FileConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_FILE_CONFIG);
  };

  return {
    config,
    setConfig,
    updateConfig,
    resetToDefaults,
    // Backward compatibility
    FILE_CONFIG: config,
  };
}

export function useFormDefaults() {
  const [config, setConfig] = useLocalStorageState<FormDefaults>(
    "tcgplayer-form-defaults",
    DEFAULT_FORM_DEFAULTS
  );

  const updateConfig = (updates: Partial<FormDefaults>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const updatePercentile = (percentile: number) => {
    setConfig((prev) => ({ ...prev, percentile }));
  };

  const updateSellerKey = (sellerKey: string) => {
    setConfig((prev) => ({ ...prev, sellerKey }));
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_FORM_DEFAULTS);
  };

  return {
    config,
    setConfig,
    updateConfig,
    updatePercentile,
    updateSellerKey,
    resetToDefaults,
    // For backward compatibility as formDefaults
    formDefaults: config,
    setFormDefaults: setConfig,
  };
}

// Composite hook for the configuration page (when all configs are needed together)
export function useConfiguration() {
  const pricingConfig = usePricingConfig();
  const supplyAnalysisConfig = useSupplyAnalysisConfig();
  const fileConfig = useFileConfig();
  const formDefaults = useFormDefaults();

  const resetAllToDefaults = () => {
    pricingConfig.resetToDefaults();
    supplyAnalysisConfig.resetToDefaults();
    fileConfig.resetToDefaults();
    formDefaults.resetToDefaults();
  };

  return {
    // Individual configs
    pricing: pricingConfig,
    supplyAnalysis: supplyAnalysisConfig,
    file: fileConfig,
    formDefaults: formDefaults,

    // Combined config object for backward compatibility
    config: {
      pricing: pricingConfig.config,
      supplyAnalysis: supplyAnalysisConfig.config,
      file: fileConfig.config,
      formDefaults: formDefaults.config,
    },

    // Individual update functions (for backward compatibility)
    updatePricingConfig: pricingConfig.updateConfig,
    updateSupplyAnalysisConfig: supplyAnalysisConfig.updateConfig,
    updateFileConfig: fileConfig.updateConfig,
    updateFormDefaults: formDefaults.updateConfig,

    // Reset all configurations
    resetToDefaults: resetAllToDefaults,

    // Computed values
    percentiles: pricingConfig.percentiles,

    // Backward compatibility helpers
    PRICING_CONSTANTS: pricingConfig.config,
    FILE_CONFIG: fileConfig.config,
  };
}
