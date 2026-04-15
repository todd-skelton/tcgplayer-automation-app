import { shippingExportConfigRepository } from "~/core/db";
import {
  createDefaultShippingExportConfig,
  mergeShippingExportConfigWithDefaults,
  type ShippingExportConfig,
} from "../types/shippingExport";
import { getDefaultEasyPostMode } from "./easyPostConfig.server";

export function applyEnvironmentEasyPostMode(
  config: ShippingExportConfig,
): ShippingExportConfig {
  const easypostMode = getDefaultEasyPostMode();

  if (config.easypostMode === easypostMode) {
    return config;
  }

  return {
    ...config,
    easypostMode,
  };
}

export async function getShippingExportConfig(): Promise<ShippingExportConfig> {
  const defaultEasyPostMode = getDefaultEasyPostMode();

  try {
    const config = await shippingExportConfigRepository.get();
    return applyEnvironmentEasyPostMode(
      mergeShippingExportConfigWithDefaults(config?.settings, {
        easypostMode: defaultEasyPostMode,
      }),
    );
  } catch (error) {
    console.warn("Failed to load shipping export config from database:", error);
    return applyEnvironmentEasyPostMode(
      createDefaultShippingExportConfig({
        easypostMode: defaultEasyPostMode,
      }),
    );
  }
}

export async function saveShippingExportConfig(
  config: ShippingExportConfig,
): Promise<ShippingExportConfig> {
  const mergedConfig = applyEnvironmentEasyPostMode(
    mergeShippingExportConfigWithDefaults(config, {
      easypostMode: getDefaultEasyPostMode(),
    }),
  );

  try {
    await shippingExportConfigRepository.save(mergedConfig);
    return mergedConfig;
  } catch (error) {
    console.error("Failed to save shipping export config:", error);
    throw error;
  }
}

export async function resetShippingExportConfig(): Promise<ShippingExportConfig> {
  return saveShippingExportConfig(
    createDefaultShippingExportConfig({
      easypostMode: getDefaultEasyPostMode(),
    }),
  );
}
