import assert from "node:assert/strict";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { createForecastCorrectionLoader } from "./api.forecast-correction.server";

const windows: number[] = [];
const loader = createForecastCorrectionLoader({
  getConfig: async () => ({ ...DEFAULT_SERVER_PRICING_CONFIG, updatedAt: new Date() }),
  load: async (_pricing, evidenceWindowDays) => {
    windows.push(evidenceWindowDays);
    return {} as never;
  },
});
const request = (query: string) =>
  ({ request: new Request(`http://localhost/api/forecast-correction${query}`), params: {}, context: {} }) as never;

const defaulted = (await loader(request(""))) as unknown as { init: ResponseInit | null };
assert.equal(defaulted.init?.status ?? 200, 200);
await loader(request("?days=28"));
assert.deepEqual(windows, [DEFAULT_SERVER_PRICING_CONFIG.pricing.forecastCorrection.evidenceWindowDays, 28]);
const rejected = (await loader(request("?days=30"))) as unknown as { init: ResponseInit | null };
assert.equal(rejected.init?.status, 400);
assert.equal(windows.length, 2);
console.log("PASS forecast correction report reads the configured window and rejects unsupported ones");
