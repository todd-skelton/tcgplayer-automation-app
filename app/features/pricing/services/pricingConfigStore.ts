import {
  DEFAULT_SERVER_PRICING_CONFIG,
  normalizeServerPricingConfig,
  type ServerPricingConfig,
} from "../types/config";

const PRICING_CONFIG_ENDPOINT = "/api/pricing-config";

type ConfigUpdater =
  ServerPricingConfig | ((prev: ServerPricingConfig) => ServerPricingConfig);

export interface PricingConfigApi {
  load(): Promise<unknown>;
  save(config: ServerPricingConfig): Promise<unknown>;
}

/**
 * The seller's pricing configuration as the browser sees it. Edits apply at
 * once and are saved one request at a time, newest edit next, so a slow
 * response from an earlier save can never overwrite a later edit. A load is
 * needed only until the server copy arrives or the seller edits.
 */
export function createPricingConfigStore(api: PricingConfigApi) {
  let config = DEFAULT_SERVER_PRICING_CONFIG;
  let loadNeeded = true;
  let loading: Promise<void> | null = null;
  let sending = false;
  let queued: ServerPricingConfig | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: ServerPricingConfig) => {
    config = next;
    listeners.forEach((listener) => listener());
  };

  const sendQueued = async () => {
    sending = true;
    while (queued) {
      const next = queued;
      queued = null;
      try {
        const saved = normalizeServerPricingConfig(await api.save(next));
        if (!queued) publish(saved);
      } catch (error) {
        console.warn("Failed to save pricing configuration:", error);
      }
    }
    sending = false;
  };

  return {
    get: () => config,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      if (!loadNeeded) return;
      loading ??= api
        .load()
        .then((raw) => {
          if (!loadNeeded) return;
          loadNeeded = false;
          publish(normalizeServerPricingConfig(raw));
        })
        .catch((error) => {
          console.warn("Failed to load pricing configuration:", error);
        })
        .finally(() => {
          loading = null;
        });
      await loading;
    },
    update(updater: ConfigUpdater) {
      const next = typeof updater === "function" ? updater(config) : updater;
      loadNeeded = false;
      queued = next;
      publish(next);
      if (!sending) void sendQueued();
    },
  };
}

async function request(init?: RequestInit): Promise<unknown> {
  const response = await fetch(PRICING_CONFIG_ENDPOINT, init);
  if (!response.ok) {
    throw new Error(`Pricing configuration request failed: ${response.status}`);
  }
  return response.json();
}

export const pricingConfigStore = createPricingConfigStore({
  load: () => request(),
  save: (config) =>
    request({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }),
});
