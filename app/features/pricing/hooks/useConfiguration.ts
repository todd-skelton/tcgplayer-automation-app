import { useLocalStorageState } from "../../../core/hooks/useLocalStorageState";
import {
  PRICING_CONSTANTS,
  FILE_CONFIG,
} from "../../../core/constants/pricing";

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

// Product line-specific pricing settings
export interface ProductLineSettings {
  percentile: number;
  skip: boolean;
}

export interface ProductLinePricingConfig {
  // Per-product-line settings keyed by productLineId
  productLineSettings: Record<number, ProductLineSettings>;
  // Default percentile for non-configured product lines
  defaultPercentile: number;
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
  enableSupplyAnalysis: true, // Enabled by default for accurate time-to-sell estimates
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

const DEFAULT_PRODUCT_LINE_PRICING_CONFIG: ProductLinePricingConfig = {
  productLineSettings: {},
  defaultPercentile: PRICING_CONSTANTS.DEFAULT_PERCENTILE,
};

// Individual configuration hooks
export function usePricingConfig() {
  const [config, setConfig] = useLocalStorageState<PricingConfig>(
    "tcgplayer-pricing-config",
    DEFAULT_PRICING_CONFIG,
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
          1,
      ),
    },
    (_, i) => config.minPercentile + i * config.percentileStep,
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
    DEFAULT_SUPPLY_ANALYSIS_CONFIG,
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
    DEFAULT_FILE_CONFIG,
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
    DEFAULT_FORM_DEFAULTS,
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

export function useProductLinePricingConfig() {
  const [config, setConfig] = useLocalStorageState<ProductLinePricingConfig>(
    "tcgplayer-product-line-pricing-config",
    DEFAULT_PRODUCT_LINE_PRICING_CONFIG,
  );

  const updateConfig = (updates: Partial<ProductLinePricingConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const setProductLineSettings = (
    productLineId: number,
    settings: ProductLineSettings,
  ) => {
    setConfig((prev) => ({
      ...prev,
      productLineSettings: {
        ...prev.productLineSettings,
        [productLineId]: settings,
      },
    }));
  };

  const removeProductLineSettings = (productLineId: number) => {
    setConfig((prev) => {
      const { [productLineId]: _, ...rest } = prev.productLineSettings;
      return {
        ...prev,
        productLineSettings: rest,
      };
    });
  };

  const setDefaultPercentile = (percentile: number) => {
    setConfig((prev) => ({ ...prev, defaultPercentile: percentile }));
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_PRODUCT_LINE_PRICING_CONFIG);
  };

  // Helper to get effective percentile for a product line
  const getEffectivePercentile = (productLineId: number): number => {
    const settings = config.productLineSettings[productLineId];
    if (settings && !settings.skip) {
      return settings.percentile;
    }
    return config.defaultPercentile;
  };

  // Helper to check if a product line should be skipped
  const shouldSkipProductLine = (productLineId: number): boolean => {
    const settings = config.productLineSettings[productLineId];
    return settings?.skip ?? false;
  };

  return {
    config,
    setConfig,
    updateConfig,
    setProductLineSettings,
    removeProductLineSettings,
    setDefaultPercentile,
    resetToDefaults,
    getEffectivePercentile,
    shouldSkipProductLine,
  };
}

// Composite hook for the configuration page (when all configs are needed together)
export function useConfiguration() {
  const pricingConfig = usePricingConfig();
  const supplyAnalysisConfig = useSupplyAnalysisConfig();
  const fileConfig = useFileConfig();
  const formDefaults = useFormDefaults();
  const productLinePricingConfig = useProductLinePricingConfig();

  const resetAllToDefaults = () => {
    pricingConfig.resetToDefaults();
    supplyAnalysisConfig.resetToDefaults();
    fileConfig.resetToDefaults();
    formDefaults.resetToDefaults();
    productLinePricingConfig.resetToDefaults();
  };

  return {
    // Individual configs
    pricing: pricingConfig,
    supplyAnalysis: supplyAnalysisConfig,
    file: fileConfig,
    formDefaults: formDefaults,
    productLinePricing: productLinePricingConfig,

    // Combined config object for backward compatibility
    config: {
      pricing: pricingConfig.config,
      supplyAnalysis: supplyAnalysisConfig.config,
      file: fileConfig.config,
      formDefaults: formDefaults.config,
      productLinePricing: productLinePricingConfig.config,
    },

    // Individual update functions (for backward compatibility)
    updatePricingConfig: pricingConfig.updateConfig,
    updateSupplyAnalysisConfig: supplyAnalysisConfig.updateConfig,
    updateFileConfig: fileConfig.updateConfig,
    updateFormDefaults: formDefaults.updateConfig,
    updateProductLinePricingConfig: productLinePricingConfig.updateConfig,

    // Reset all configurations
    resetToDefaults: resetAllToDefaults,

    // Computed values
    percentiles: pricingConfig.percentiles,

    // Backward compatibility helpers
    PRICING_CONSTANTS: pricingConfig.config,
    FILE_CONFIG: fileConfig.config,
  };
}
