import { httpConfigDb } from "../../datastores.server";

export interface HttpConfig {
  tcgAuthCookie: string;
  userAgent: string;
  requestDelayMs: number;
  rateLimitCooldownMs: number;
  maxConcurrentRequests: number;
}

const DEFAULT_HTTP_CONFIG: HttpConfig = {
  tcgAuthCookie: "",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  requestDelayMs: 1500,
  rateLimitCooldownMs: 60000,
  maxConcurrentRequests: 5,
};

// Server-side helper - reads from database
export async function getHttpConfig(): Promise<HttpConfig> {
  try {
    const config = await httpConfigDb.findOne({});
    if (config) {
      const { _id, ...httpConfig } = config;
      return httpConfig as HttpConfig;
    }
  } catch (error) {
    console.warn("Failed to load HTTP config from database:", error);
  }
  return DEFAULT_HTTP_CONFIG;
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

export { DEFAULT_HTTP_CONFIG };
