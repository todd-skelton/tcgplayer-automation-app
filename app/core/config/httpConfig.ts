import { useLocalStorageState } from "../hooks/useLocalStorageState";

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

export function useHttpConfig() {
  const [config, setConfig] = useLocalStorageState<HttpConfig>(
    "tcgplayer-http-config",
    DEFAULT_HTTP_CONFIG
  );

  const updateConfig = (updates: Partial<HttpConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const updateAuthCookie = (tcgAuthCookie: string) => {
    setConfig((prev) => ({ ...prev, tcgAuthCookie }));
  };

  const resetToDefaults = () => {
    setConfig(DEFAULT_HTTP_CONFIG);
  };

  return {
    config,
    setConfig,
    updateConfig,
    updateAuthCookie,
    resetToDefaults,
  };
}

// Singleton instance for non-React contexts
let httpConfigInstance: HttpConfig | null = null;

export function getHttpConfig(): HttpConfig {
  if (typeof window !== "undefined" && !httpConfigInstance) {
    try {
      const stored = localStorage.getItem("tcgplayer-http-config");
      if (stored) {
        httpConfigInstance = JSON.parse(stored);
      }
    } catch (error) {
      console.warn("Failed to load HTTP config from localStorage:", error);
    }
  }
  return httpConfigInstance || DEFAULT_HTTP_CONFIG;
}

export function setHttpConfigInstance(config: HttpConfig) {
  httpConfigInstance = config;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem("tcgplayer-http-config", JSON.stringify(config));
    } catch (error) {
      console.warn("Failed to save HTTP config to localStorage:", error);
    }
  }
}
