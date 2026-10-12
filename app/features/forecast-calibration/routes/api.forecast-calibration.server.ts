import { data, type LoaderFunctionArgs } from "react-router";
import {
  DEFAULT_FORECAST_CALIBRATION_WINDOW_DAYS,
  FORECAST_CALIBRATION_WINDOW_DAYS,
} from "../domain/forecastCalibrationModel";
import { loadForecastCalibration } from "../services/forecastCalibration.server";

export function createForecastCalibrationLoader(load = loadForecastCalibration) {
  return async function forecastCalibrationLoader({ request }: LoaderFunctionArgs) {
    const requested = new URL(request.url).searchParams.get("days");
    const days = requested === null ? DEFAULT_FORECAST_CALIBRATION_WINDOW_DAYS : Number(requested);
    if (!FORECAST_CALIBRATION_WINDOW_DAYS.some((allowed) => allowed === days)) {
      return data(
        { error: `days must be one of ${FORECAST_CALIBRATION_WINDOW_DAYS.join(", ")}.` },
        { status: 400 },
      );
    }
    try {
      return data(await load(days));
    } catch (error) {
      console.error("Forecast calibration report failed", error);
      return data(
        { error: error instanceof Error ? error.message : "Forecast calibration could not be learned." },
        { status: 500 },
      );
    }
  };
}

export const loader = createForecastCalibrationLoader();
