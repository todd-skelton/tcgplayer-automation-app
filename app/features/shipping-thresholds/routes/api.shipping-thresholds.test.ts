import assert from "node:assert/strict";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { createShippingThresholdsLoader } from "./api.shipping-thresholds.server";

const calls: Array<{ windowDays: number; overheadRate: number }> = [];
const loader = createShippingThresholdsLoader({
  getConfig: async () => ({ ...DEFAULT_SERVER_PRICING_CONFIG, updatedAt: new Date() }),
  load: async (settings, overheadRate, windowDays) => {
    calls.push({ windowDays, overheadRate });
    return { settings } as never;
  },
});
const request = (query: string) =>
  ({ request: new Request(`http://localhost/api/shipping-thresholds${query}`), params: {}, context: {} }) as never;

const defaulted = (await loader(request(""))) as unknown as { init: ResponseInit | null };
assert.equal(defaulted.init?.status ?? 200, 200);
await loader(request("?days=30"));
assert.deepEqual(calls, [
  { windowDays: 90, overheadRate: DEFAULT_SERVER_PRICING_CONFIG.pricing.profitPerDay.relativeOverhead },
  { windowDays: 30, overheadRate: DEFAULT_SERVER_PRICING_CONFIG.pricing.profitPerDay.relativeOverhead },
]);
const rejected = (await loader(request("?days=45"))) as unknown as { init: ResponseInit | null };
assert.equal(rejected.init?.status, 400);
assert.equal(calls.length, 2);
console.log("PASS shipping threshold report reads the configured window and rejects unsupported ones");
