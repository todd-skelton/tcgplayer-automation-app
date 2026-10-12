import assert from "node:assert/strict";
import { DEFAULT_FORECAST_CALIBRATION_WINDOW_DAYS } from "../domain/forecastCalibrationModel";
import { createForecastCalibrationLoader } from "./api.forecast-calibration.server";

const windows: number[] = [];
const loader = createForecastCalibrationLoader(async (evidenceWindowDays) => {
  windows.push(evidenceWindowDays);
  return {} as never;
});
const request = (query: string) =>
  ({ request: new Request(`http://localhost/api/forecast-calibration${query}`), params: {}, context: {} }) as never;

const defaulted = (await loader(request(""))) as unknown as { init: ResponseInit | null };
assert.equal(defaulted.init?.status ?? 200, 200);
await loader(request("?days=28"));
assert.deepEqual(windows, [DEFAULT_FORECAST_CALIBRATION_WINDOW_DAYS, 28]);
const rejected = (await loader(request("?days=30"))) as unknown as { init: ResponseInit | null };
assert.equal(rejected.init?.status, 400);
assert.equal(windows.length, 2);
console.log("PASS forecast calibration report defaults its window and rejects unsupported ones");
