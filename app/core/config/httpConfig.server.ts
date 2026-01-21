import { httpConfigDb } from "../../datastores.server";

// Re-export types and constants from shared module
export {
  DOMAIN_KEYS,
  TCGPLAYER_DOMAINS,
  DEFAULT_DOMAIN_CONFIGS,
  DEFAULT_HTTP_CONFIG,
  type DomainKey,
  type DomainRateLimitConfig,
  type DomainConfigs,
  type HttpConfig,
} from "./httpConfig.shared";

import {
  DOMAIN_KEYS,
  DEFAULT_DOMAIN_CONFIGS,
  DEFAULT_HTTP_CONFIG,
  type DomainKey,
  type DomainRateLimitConfig,
  type HttpConfig,
} from "./httpConfig.shared";

// Server-side helper - reads from database
export async function getHttpConfig(): Promise<HttpConfig> {
  try {
    const config = await httpConfigDb.findOne({});
    if (config) {
      const { _id, ...httpConfig } = config;
      // Ensure all domains exist (in case new domains are added)
      const mergedDomainConfigs = {
        ...DEFAULT_DOMAIN_CONFIGS,
        ...httpConfig.domainConfigs,
      };
      return {
        ...httpConfig,
        domainConfigs: mergedDomainConfigs,
      } as HttpConfig;
    }
  } catch (error) {
    console.warn("Failed to load HTTP config from database:", error);
  }
  return DEFAULT_HTTP_CONFIG;
}

// Helper to get config for a specific domain
export async function getDomainConfig(
  domainKey: DomainKey,
): Promise<DomainRateLimitConfig> {
  const config = await getHttpConfig();
  return config.domainConfigs[domainKey] ?? DEFAULT_DOMAIN_CONFIGS[domainKey];
}

// Save to database
export async function saveHttpConfig(config: HttpConfig): Promise<void> {
  try {
    await httpConfigDb.update({}, config, { upsert: true });
  } catch (error) {
    console.error("Failed to save HTTP config:", error);
    throw error;
  }
}
