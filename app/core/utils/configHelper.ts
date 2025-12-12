import type { HttpConfig } from "../config/httpConfig";

/**
 * Gets HTTP config from localStorage for including in client-side API requests
 */
export function getClientHttpConfig(): HttpConfig | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = localStorage.getItem("tcgplayer-http-config");
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error("Failed to get HTTP config:", error);
  }
  return null;
}

/**
 * Extracts and sets HTTP config for server-side request handlers.
 * Call this at the beginning of server action/loader functions.
 */
export async function applyHttpConfigFromRequest(request: Request) {
  try {
    // Try to get from JSON body first (for POST requests)
    if (request.method === "POST") {
      const body = await request.json();
      if (body.httpConfig) {
        const { setRequestConfig } = await import("../httpClient");
        setRequestConfig(body.httpConfig as HttpConfig);
        return body; // Return body so caller doesn't need to parse again
      }
      return body;
    }

    // For GET requests, try from query params
    const url = new URL(request.url);
    const httpConfigJson = url.searchParams.get("httpConfig");
    if (httpConfigJson) {
      const httpConfig = JSON.parse(httpConfigJson);
      const { setRequestConfig } = await import("../httpClient");
      setRequestConfig(httpConfig);
    }
    return null;
  } catch (error) {
    console.error("Failed to apply HTTP config:", error);
    return null;
  }
}

/**
 * Extracts HTTP config from FormData (for form submissions)
 */
export async function applyHttpConfigFromFormData(formData: FormData) {
  try {
    const httpConfigJson = formData.get("httpConfig");
    if (httpConfigJson) {
      const httpConfig = JSON.parse(httpConfigJson as string);
      const { setRequestConfig } = await import("../httpClient");
      setRequestConfig(httpConfig as HttpConfig);
    }
  } catch (error) {
    console.error("Failed to apply HTTP config:", error);
  }
}
