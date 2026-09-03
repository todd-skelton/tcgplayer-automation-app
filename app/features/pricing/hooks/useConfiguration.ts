import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useLocalStorageState } from "../../../core/hooks/useLocalStorageState";
import { pricingConfigStore } from "../services/pricingConfigStore";
import {
  DEFAULT_FILE_CONFIG,
  DEFAULT_FORM_DEFAULTS,
  DEFAULT_PRODUCT_LINE_PRICING_CONFIG,
  DEFAULT_PRICING_CONFIG,
  DEFAULT_SERVER_PRICING_CONFIG,
  DEFAULT_SUPPLY_ANALYSIS_CONFIG,
  type FileConfig,
  type FormDefaults,
  type PricingConfigSettings,
  type ProductLinePricingConfig,
  type ProductLineSettings,
  type SupplyAnalysisConfig,
} from "../types/config";

function useServerPricingConfiguration() {
  const config = useSyncExternalStore(
    pricingConfigStore.subscribe,
    pricingConfigStore.get,
    pricingConfigStore.get,
  );
  useEffect(() => {
    void pricingConfigStore.load();
  }, []);

  return { config, setConfig: pricingConfigStore.update };
}

export function usePricingConfig() {
  const serverConfig = useServerPricingConfiguration();
  const config = serverConfig.config.pricing;

  const percentiles = useMemo(
    () =>
      Array.from(
        {
          length:
            Math.floor(
              (config.maxPercentile - config.minPercentile) /
                config.percentileStep,
            ) + 1,
        },
        (_, index) => config.minPercentile + index * config.percentileStep,
      ),
    [config.maxPercentile, config.minPercentile, config.percentileStep],
  );

  const updateConfig = (updates: Partial<PricingConfigSettings>) => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      pricing: {
        ...prev.pricing,
        ...updates,
        successRateThreshold: {
          ...prev.pricing.successRateThreshold,
          ...(updates.successRateThreshold ?? {}),
        },
      },
    }));
  };

  const resetToDefaults = () => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      pricing: DEFAULT_PRICING_CONFIG,
    }));
  };

  return {
    config,
    setConfig: (nextConfig: PricingConfigSettings) => {
      serverConfig.setConfig((prev) => ({
        ...prev,
        pricing: nextConfig,
      }));
    },
    updateConfig,
    resetToDefaults,
    percentiles,
    PRICING_CONSTANTS: config,
  };
}

export function useSupplyAnalysisConfig() {
  const serverConfig = useServerPricingConfiguration();
  const config = serverConfig.config.supplyAnalysis;

  const updateConfig = (updates: Partial<SupplyAnalysisConfig>) => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      supplyAnalysis: {
        ...prev.supplyAnalysis,
        ...updates,
      },
    }));
  };

  const resetToDefaults = () => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      supplyAnalysis: DEFAULT_SUPPLY_ANALYSIS_CONFIG,
    }));
  };

  return {
    config,
    setConfig: (nextConfig: SupplyAnalysisConfig) => {
      serverConfig.setConfig((prev) => ({
        ...prev,
        supplyAnalysis: nextConfig,
      }));
    },
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
    formDefaults: config,
    setFormDefaults: setConfig,
  };
}

export function useProductLinePricingConfig() {
  const serverConfig = useServerPricingConfiguration();
  const config = serverConfig.config.productLinePricing;

  const updateConfig = (updates: Partial<ProductLinePricingConfig>) => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      productLinePricing: {
        ...prev.productLinePricing,
        ...updates,
        productLineSettings:
          updates.productLineSettings ?? prev.productLinePricing.productLineSettings,
      },
    }));
  };

  const setProductLineSettings = (
    productLineId: number,
    settings: ProductLineSettings,
  ) => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      productLinePricing: {
        ...prev.productLinePricing,
        productLineSettings: {
          ...prev.productLinePricing.productLineSettings,
          [productLineId]: settings,
        },
      },
    }));
  };

  const removeProductLineSettings = (productLineId: number) => {
    serverConfig.setConfig((prev) => {
      const { [productLineId]: _ignored, ...rest } =
        prev.productLinePricing.productLineSettings;

      return {
        ...prev,
        productLinePricing: {
          ...prev.productLinePricing,
          productLineSettings: rest,
        },
      };
    });
  };

  const setDefaultPercentile = (percentile: number) => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      productLinePricing: {
        ...prev.productLinePricing,
        defaultPercentile: percentile,
      },
    }));
  };

  const resetToDefaults = () => {
    serverConfig.setConfig((prev) => ({
      ...prev,
      productLinePricing: DEFAULT_PRODUCT_LINE_PRICING_CONFIG,
    }));
  };

  const getEffectivePercentile = (productLineId: number): number => {
    const settings = config.productLineSettings[productLineId];
    if (settings && !settings.skip) {
      return settings.percentile;
    }
    return config.defaultPercentile;
  };

  const shouldSkipProductLine = (productLineId: number): boolean => {
    const settings = config.productLineSettings[productLineId];
    return settings?.skip ?? false;
  };

  return {
    config,
    setConfig: (nextConfig: ProductLinePricingConfig) => {
      serverConfig.setConfig((prev) => ({
        ...prev,
        productLinePricing: nextConfig,
      }));
    },
    updateConfig,
    setProductLineSettings,
    removeProductLineSettings,
    setDefaultPercentile,
    resetToDefaults,
    getEffectivePercentile,
    shouldSkipProductLine,
  };
}

export function useConfiguration() {
  const pricingConfig = usePricingConfig();
  const supplyAnalysisConfig = useSupplyAnalysisConfig();
  const fileConfig = useFileConfig();
  const formDefaults = useFormDefaults();
  const productLinePricingConfig = useProductLinePricingConfig();

  const resetAllToDefaults = () => {
    pricingConfigStore.update(DEFAULT_SERVER_PRICING_CONFIG);
    fileConfig.resetToDefaults();
    formDefaults.resetToDefaults();
  };

  return {
    pricing: pricingConfig,
    supplyAnalysis: supplyAnalysisConfig,
    file: fileConfig,
    formDefaults,
    productLinePricing: productLinePricingConfig,
    config: {
      pricing: pricingConfig.config,
      supplyAnalysis: supplyAnalysisConfig.config,
      file: fileConfig.config,
      formDefaults: formDefaults.config,
      productLinePricing: productLinePricingConfig.config,
    },
    updatePricingConfig: pricingConfig.updateConfig,
    updateSupplyAnalysisConfig: supplyAnalysisConfig.updateConfig,
    updateFileConfig: fileConfig.updateConfig,
    updateFormDefaults: formDefaults.updateConfig,
    updateProductLinePricingConfig: productLinePricingConfig.updateConfig,
    resetToDefaults: resetAllToDefaults,
    percentiles: pricingConfig.percentiles,
    PRICING_CONSTANTS: pricingConfig.config,
    FILE_CONFIG: fileConfig.config,
  };
}
