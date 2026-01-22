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
  /** Enable adaptive rate limiting (AIMD algorithm) */
  adaptiveEnabled: boolean;
  /** Minimum delay when adaptive is enabled */
  minRequestDelayMs: number;
  /** Maximum delay when adaptive is enabled */
  maxRequestDelayMs: number;
  /** Runtime-learned minimum delay (ratchets upward on rate limits) */
  learnedMinDelayMs: number;
}

export type DomainConfigs = Record<DomainKey, DomainRateLimitConfig>;

// Default rate limits per domain - can be tuned based on observed API behavior
export const DEFAULT_DOMAIN_CONFIGS: DomainConfigs = {
  [DOMAIN_KEYS.MP_SEARCH_API]: {
    requestDelayMs: 0,
    rateLimitCooldownMs: 10000,
    maxConcurrentRequests: 5,
    adaptiveEnabled: true,
    minRequestDelayMs: 0,
    maxRequestDelayMs: 10000,
    learnedMinDelayMs: 0,
  },
  [DOMAIN_KEYS.MPAPI]: {
    requestDelayMs: 0,
    rateLimitCooldownMs: 10000,
    maxConcurrentRequests: 5,
    adaptiveEnabled: true,
    minRequestDelayMs: 0,
    maxRequestDelayMs: 10000,
    learnedMinDelayMs: 0,
  },
  [DOMAIN_KEYS.INFINITE_API]: {
    requestDelayMs: 0,
    rateLimitCooldownMs: 10000,
    maxConcurrentRequests: 5,
    adaptiveEnabled: true,
    minRequestDelayMs: 0,
    maxRequestDelayMs: 10000,
    learnedMinDelayMs: 0,
  },
  [DOMAIN_KEYS.MP_GATEWAY]: {
    requestDelayMs: 0,
    rateLimitCooldownMs: 10000,
    maxConcurrentRequests: 5,
    adaptiveEnabled: true,
    minRequestDelayMs: 0,
    maxRequestDelayMs: 10000,
    learnedMinDelayMs: 0,
  },
};

// ============================================================================
// Main HTTP Configuration
// ============================================================================

/** Global settings for the adaptive rate limiting algorithm */
export interface AdaptiveConfig {
  /** Multiplier applied to delay on rate limit (e.g., 2.0 = double) */
  increaseMultiplier: number;
  /** Amount (ms) to raise the learned floor on rate limit */
  floorStepMs: number;
  /** Amount (ms) to decrease delay after success streak */
  decreaseAmountMs: number;
  /** Number of consecutive successes before decreasing delay */
  successThreshold: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  increaseMultiplier: 2.0,
  floorStepMs: 100,
  decreaseAmountMs: 100,
  successThreshold: 10,
};

export interface HttpConfig {
  tcgAuthCookie: string;
  userAgent: string;
  /** Per-domain rate limit configurations */
  domainConfigs: DomainConfigs;
  /** Global adaptive rate limiting algorithm settings */
  adaptiveConfig: AdaptiveConfig;
}

export const DEFAULT_HTTP_CONFIG: HttpConfig = {
  tcgAuthCookie: "",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  domainConfigs: DEFAULT_DOMAIN_CONFIGS,
  adaptiveConfig: DEFAULT_ADAPTIVE_CONFIG,
};

// Human-readable domain names for display in UI
export const DOMAIN_DISPLAY_NAMES: Record<DomainKey, string> = {
  [DOMAIN_KEYS.MP_SEARCH_API]: "Search API (mp-search-api)",
  [DOMAIN_KEYS.MPAPI]: "Marketplace API (mpapi)",
  [DOMAIN_KEYS.INFINITE_API]: "Infinite API (infinite-api)",
  [DOMAIN_KEYS.MP_GATEWAY]: "Gateway API (mpgateway)",
};
