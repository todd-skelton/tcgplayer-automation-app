/**
 * Shared HTTP configuration types and constants.
 * This file can be imported by both client and server code.
 */

// ============================================================================
// Domain Constants
// ============================================================================

// Short keys for storage (NeDB doesn't allow dots in field names)
export const DOMAIN_KEYS = {
  MP_SEARCH_API: "mpSearchApi",
  MPAPI: "mpApi",
  INFINITE_API: "infiniteApi",
  MP_GATEWAY: "mpGateway",
} as const;

export type DomainKey = (typeof DOMAIN_KEYS)[keyof typeof DOMAIN_KEYS];

// Full domain URLs for HTTP requests
export const TCGPLAYER_DOMAINS: Record<DomainKey, string> = {
  [DOMAIN_KEYS.MP_SEARCH_API]: "mp-search-api.tcgplayer.com",
  [DOMAIN_KEYS.MPAPI]: "mpapi.tcgplayer.com",
  [DOMAIN_KEYS.INFINITE_API]: "infinite-api.tcgplayer.com",
  [DOMAIN_KEYS.MP_GATEWAY]: "mpgateway.tcgplayer.com",
};

// ============================================================================
// Domain Rate Limit Configuration
// ============================================================================

export interface DomainRateLimitConfig {
  requestDelayMs: number;
  rateLimitCooldownMs: number;
  maxConcurrentRequests: number;
}

export type DomainConfigs = Record<DomainKey, DomainRateLimitConfig>;

// Default rate limits per domain - can be tuned based on observed API behavior
export const DEFAULT_DOMAIN_CONFIGS: DomainConfigs = {
  [DOMAIN_KEYS.MP_SEARCH_API]: {
    requestDelayMs: 1500,
    rateLimitCooldownMs: 60000,
    maxConcurrentRequests: 5,
  },
  [DOMAIN_KEYS.MPAPI]: {
    requestDelayMs: 1500,
    rateLimitCooldownMs: 60000,
    maxConcurrentRequests: 5,
  },
  [DOMAIN_KEYS.INFINITE_API]: {
    requestDelayMs: 1500,
    rateLimitCooldownMs: 60000,
    maxConcurrentRequests: 5,
  },
  [DOMAIN_KEYS.MP_GATEWAY]: {
    requestDelayMs: 1500,
    rateLimitCooldownMs: 60000,
    maxConcurrentRequests: 5,
  },
};

// ============================================================================
// Main HTTP Configuration
// ============================================================================

export interface HttpConfig {
  tcgAuthCookie: string;
  userAgent: string;
  /** Per-domain rate limit configurations */
  domainConfigs: DomainConfigs;
}

export const DEFAULT_HTTP_CONFIG: HttpConfig = {
  tcgAuthCookie: "",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  domainConfigs: DEFAULT_DOMAIN_CONFIGS,
};

// Human-readable domain names for display in UI
export const DOMAIN_DISPLAY_NAMES: Record<DomainKey, string> = {
  [DOMAIN_KEYS.MP_SEARCH_API]: "Search API (mp-search-api)",
  [DOMAIN_KEYS.MPAPI]: "Marketplace API (mpapi)",
  [DOMAIN_KEYS.INFINITE_API]: "Infinite API (infinite-api)",
  [DOMAIN_KEYS.MP_GATEWAY]: "Gateway API (mpgateway)",
};
