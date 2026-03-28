import { useEffect, useMemo, useState } from "react";
import { useLocalStorageState } from "../../../core/hooks/useLocalStorageState";
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
  type ServerPricingConfig,
  type SupplyAnalysisConfig,
} from "../types/config";

const SERVER_CONFIG_ENDPOINT = "/api/pricing-config";

type ServerConfigUpdater =
  | ServerPricingConfig
  | ((prev: ServerPricingConfig) => ServerPricingConfig);

let serverConfigCache: ServerPricingConfig = DEFAULT_SERVER_PRICING_CONFIG;
let serverConfigLoaded = false;
let serverConfigLoadPromise: Promise<void> | null = null;
const serverConfigListeners = new Set<() => void>();

function notifyServerConfigListeners(): void {
  serverConfigListeners.forEach((listener) => listener());
}

function normalizeServerPricingConfig(value: unknown): ServerPricingConfig {
  const raw = (value ?? {}) as Partial<ServerPricingConfig>;

  return {
    pricing: {
      ...DEFAULT_PRICING_CONFIG,
      ...(raw.pricing ?? {}),
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
      productLineSettings: raw.productLinePricing?.productLineSettings ?? {},
    },
  };
}

async function loadServerConfig(): Promise<void> {
  if (serverConfigLoaded) {
    return;
  }

  if (!serverConfigLoadPromise) {
    serverConfigLoadPromise = fetch(SERVER_CONFIG_ENDPOINT)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load pricing configuration");
        }

        serverConfigCache = normalizeServerPricingConfig(await response.json());
        serverConfigLoaded = true;
        notifyServerConfigListeners();
      })
      .catch((error) => {
        console.warn("Failed to load pricing configuration:", error);
      })
      .finally(() => {
        serverConfigLoadPromise = null;
      });
  }

  await serverConfigLoadPromise;
}

async function persistServerConfig(nextConfig: ServerPricingConfig): Promise<void> {
  serverConfigCache = nextConfig;
  notifyServerConfigListeners();

  try {
    const response = await fetch(SERVER_CONFIG_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextConfig),
    });

    if (!response.ok) {
      throw new Error("Failed to save pricing configuration");
    }

    serverConfigCache = normalizeServerPricingConfig(await response.json());
    serverConfigLoaded = true;
  } catch (error) {
    console.warn("Failed to save pricing configuration:", error);
  } finally {
    notifyServerConfigListeners();
  }
}

function updateServerConfig(updater: ServerConfigUpdater): void {
  const nextConfig =
    typeof updater === "function" ? updater(serverConfigCache) : updater;
  void persistServerConfig(nextConfig);
}

function subscribeToServerConfig(listener: () => void): () => void {
  serverConfigListeners.add(listener);
  return () => {
    serverConfigListeners.delete(listener);
  };
}

function useServerPricingConfiguration() {
  const [config, setConfigState] = useState<ServerPricingConfig>(serverConfigCache);

  useEffect(() => subscribeToServerConfig(() => setConfigState(serverConfigCache)), []);
  useEffect(() => {
    void loadServerConfig();
  }, []);

  return {
    config,
    setConfig: updateServerConfig,
    isLoaded: serverConfigLoaded,
  };
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
    updateServerConfig(DEFAULT_SERVER_PRICING_CONFIG);
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
