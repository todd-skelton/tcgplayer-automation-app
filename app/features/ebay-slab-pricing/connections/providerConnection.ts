export const SLAB_PROVIDERS = ["alt", "ebayResearch"] as const;
export type SlabProvider = (typeof SLAB_PROVIDERS)[number];

export const CONNECTION_MESSAGES = {
  "not-configured": "Add a connection to check access.",
  unchecked: "Connection saved. Check access to verify it.",
  connected: "Connection verified.",
  "reconnect-required":
    "Sign in to the provider and replace the saved connection.",
  busy: "Another request is running or this provider is cooling down. Try again shortly.",
  "rate-limited":
    "The provider asked us to wait. Try again after its cooldown.",
  unavailable: "The provider is temporarily unavailable. Try again shortly.",
  "invalid-response":
    "The provider returned an unexpected response. The adapter may need updating.",
  cancelled: "Connection check cancelled or timed out.",
} as const;
export type ConnectionStatus = keyof typeof CONNECTION_MESSAGES;
export type ProviderConnectionStatus = {
  provider: SlabProvider;
  configured: boolean;
  status: ConnectionStatus;
  checkedAt: Date | null;
};

export function isSlabProvider(value: unknown): value is SlabProvider {
  return SLAB_PROVIDERS.some((provider) => provider === value);
}
