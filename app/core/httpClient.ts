import type { HttpConfig } from "./config/httpConfig.shared";

let requestConfig: HttpConfig | null = null;

export function setRequestConfig(config: HttpConfig): void {
  requestConfig = config;
}

export function getRequestConfig(): HttpConfig | null {
  return requestConfig;
}
