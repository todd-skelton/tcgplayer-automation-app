import { httpConfigDb } from "../../datastores.server";

// Re-export types and constants from shared module
export {
  DOMAIN_KEYS,
  TCGPLAYER_DOMAINS,
  DEFAULT_DOMAIN_CONFIGS,
  DEFAULT_HTTP_CONFIG,
  DEFAULT_ADAPTIVE_CONFIG,
  type DomainKey,
  type DomainRateLimitConfig,
  type DomainConfigs,
  type HttpConfig,
  type AdaptiveConfig,
} from "./httpConfig.shared";

import {
  DOMAIN_KEYS,
  DEFAULT_DOMAIN_CONFIGS,
  DEFAULT_HTTP_CONFIG,
  DEFAULT_ADAPTIVE_CONFIG,
  type DomainKey,
  type DomainRateLimitConfig,
  type HttpConfig,
  type AdaptiveConfig,
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
      // Ensure adaptive config exists (in case upgrading from older DB)
      const mergedAdaptiveConfig = {
        ...DEFAULT_ADAPTIVE_CONFIG,
        ...httpConfig.adaptiveConfig,
      };
      return {
        ...httpConfig,
        domainConfigs: mergedDomainConfigs,
        adaptiveConfig: mergedAdaptiveConfig,
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

// Update delays for a specific domain (used by adaptive rate limiting)
export async function updateDomainDelays(
  domainKey: DomainKey,
  requestDelayMs: number,
  learnedMinDelayMs: number,
): Promise<void> {
  try {
    const config = await getHttpConfig();
    config.domainConfigs[domainKey] = {
      ...config.domainConfigs[domainKey],
      requestDelayMs,
      learnedMinDelayMs,
    };
    await httpConfigDb.update({}, config, { upsert: true });
    console.log(
      `[HTTP:${domainKey}] Adaptive: delay=${requestDelayMs}ms, floor=${learnedMinDelayMs}ms`,
    );
  } catch (error) {
    console.error("Failed to update domain delays:", error);
    // Don't throw - adaptive updates are non-critical
  }
}
