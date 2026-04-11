import { shippingExportConfigRepository } from "~/core/db";
import {
  DEFAULT_SHIPPING_EXPORT_CONFIG,
  mergeShippingExportConfigWithDefaults,
  type ShippingExportConfig,
} from "../types/shippingExport";

export async function getShippingExportConfig(): Promise<ShippingExportConfig> {
  try {
    const config = await shippingExportConfigRepository.get();
    return mergeShippingExportConfigWithDefaults(config?.settings);
  } catch (error) {
    console.warn("Failed to load shipping export config from database:", error);
    return DEFAULT_SHIPPING_EXPORT_CONFIG;
  }
}

export async function saveShippingExportConfig(
  config: ShippingExportConfig,
): Promise<ShippingExportConfig> {
  const mergedConfig = mergeShippingExportConfigWithDefaults(config);

  try {
    await shippingExportConfigRepository.save(mergedConfig);
    return mergedConfig;
  } catch (error) {
    console.error("Failed to save shipping export config:", error);
    throw error;
  }
}

export async function resetShippingExportConfig(): Promise<ShippingExportConfig> {
  return saveShippingExportConfig(DEFAULT_SHIPPING_EXPORT_CONFIG);
}
