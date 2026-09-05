import { setTimeout as delay } from "node:timers/promises";
import type { SlabProvider, ConnectionStatus } from "./providerConnection";

export class ProviderRequestError extends Error {
  constructor(public readonly status: ConnectionStatus) {
    // Never attach transport errors: they can contain authorization headers.
    super(status);
    this.name = "ProviderRequestError";
  }
}

export type ProviderLease = {
  id: string;
  revision: number;
  credential: string;
  userAgent: string;
};
export type ProviderRequestGate = {
  claim(provider: SlabProvider): Promise<ProviderLease>;
  release(
    provider: SlabProvider,
    lease: ProviderLease,
    result: {
      status: ConnectionStatus;
      retryAt: number;
    },
  ): Promise<void>;
};

const ORIGINS = {
  alt: "https://alt-platform-server.production.internal.onlyalt.com",
  ebayResearch: "https://www.ebay.com",
} as const;
export const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_GAP_MS = 2_000;

function providerUrl(provider: SlabProvider, path: string): URL {
  const url = new URL(path, ORIGINS[provider]);
  const validPath =
    provider === "alt"
      ? url.pathname.startsWith("/graphql/")
      : url.pathname === "/sh/research/api/search";
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    url.origin !== ORIGINS[provider] ||
    !validPath ||
    url.username ||
    url.password
  ) {
    throw new ProviderRequestError("invalid-response");
  }
  return url;
}

async function readText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderRequestError("invalid-response");
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new ProviderRequestError("invalid-response");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return REQUEST_GAP_MS;
  const seconds = /^\d+(\.\d+)?$/.test(header) ? Number(header) : null;
  const value = seconds === null ? Date.parse(header) - now : seconds * 1000;
  return Number.isFinite(value) && value >= 0 && value < 8.64e15 - now
    ? Math.max(REQUEST_GAP_MS, value)
    : REQUEST_GAP_MS;
}

/** Fixed-origin, read-only provider transport. The gate coordinates every process. */
export function createProviderRequest(
  gate: ProviderRequestGate,
  fetcher: typeof fetch = fetch,
) {
  return async function requestProvider(
    provider: SlabProvider,
    request: { path: string; body?: string },
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      validate?: (body: string) => void;
    } = {},
  ): Promise<string> {
    const url = providerUrl(provider, request.path);
    const requestedTimeout = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw new ProviderRequestError("invalid-response");
    }
    const timeoutMs = Math.min(
      Math.ceil(requestedTimeout),
      PROVIDER_TIMEOUT_MS,
    );
    const deadline = Date.now() + timeoutMs;
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    let lease: ProviderLease | undefined;
    let status: ConnectionStatus = "unavailable";
    let retryAt = 0;
    try {
      signal.throwIfAborted();
      lease = await gate.claim(provider);
      signal.throwIfAborted();
      const headers: Record<string, string> =
        provider === "alt"
          ? {
              Authorization: `Bearer ${lease.credential}`,
              "Content-Type": "application/json",
              Origin: "https://alt.xyz",
              Referer: "https://alt.xyz/",
            }
          : {
              Cookie: lease.credential,
              "User-Agent": lease.userAgent,
              Referer: "https://www.ebay.com/sh/research",
            };
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        let response: Response;
        try {
          response = await fetcher(url, {
            method: request.body === undefined ? "GET" : "POST",
            headers,
            body: request.body,
            redirect: "manual",
            signal,
          });
        } catch {
          if (signal.aborted) throw new ProviderRequestError("cancelled");
          if (attempt === 2) throw new ProviderRequestError("unavailable");
          await delay(REQUEST_GAP_MS * (attempt + 1), undefined, { signal });
          continue;
        }
        if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
          await response.body?.cancel();
          throw new ProviderRequestError("reconnect-required");
        }
        if ([429, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          const wait = retryAfterMs(response.headers.get("retry-after"));
          retryAt = Date.now() + wait;
          if (attempt === 2 || wait >= deadline - Date.now()) {
            throw new ProviderRequestError(
              response.status === 429 ? "rate-limited" : "unavailable",
            );
          }
          await delay(wait, undefined, { signal });
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderRequestError("invalid-response");
        }
        const body = await readText(response, signal);
        if (/^\s*</.test(body))
          throw new ProviderRequestError("reconnect-required");
        options.validate?.(body);
        status = "connected";
        return body;
      }
      throw new ProviderRequestError("unavailable");
    } catch (error) {
      status = signal.aborted
        ? "cancelled"
        : error instanceof ProviderRequestError
          ? error.status
          : "unavailable";
      throw new ProviderRequestError(status);
    } finally {
      if (lease) {
        const cooldown =
          status === "unavailable" || status === "invalid-response"
            ? 30_000
            : REQUEST_GAP_MS;
        try {
          await gate.release(provider, lease, {
            status,
            retryAt: Math.max(retryAt, Date.now() + cooldown),
          });
        } catch {
          // A lost database connection leaves the lease to expire. Never expose its error.
          throw new ProviderRequestError("unavailable");
        }
      }
    }
  };
}
