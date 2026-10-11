import { data, type LoaderFunctionArgs } from "react-router";
import { pricingConfigRepository } from "~/core/db";
import { FORECAST_EVIDENCE_WINDOW_DAYS } from "~/features/pricing/types/config";
import { loadForecastCorrectionStatus } from "../services/forecastCorrection.server";

export function createForecastCorrectionLoader(dependencies = {
  getConfig: () => pricingConfigRepository.get(),
  load: loadForecastCorrectionStatus,
}) {
  return async function forecastCorrectionLoader({ request }: LoaderFunctionArgs) {
    try {
      const config = await dependencies.getConfig();
      const requested = new URL(request.url).searchParams.get("days");
      const days = requested === null
        ? config.pricing.forecastCorrection.evidenceWindowDays
        : Number(requested);
      if (!FORECAST_EVIDENCE_WINDOW_DAYS.some((allowed) => allowed === days)) {
        return data(
          { error: `days must be one of ${FORECAST_EVIDENCE_WINDOW_DAYS.join(", ")}.` },
          { status: 400 },
        );
      }
      return data(await dependencies.load(config.pricing, days));
    } catch (error) {
      console.error("Forecast correction report failed", error);
      return data(
        { error: error instanceof Error ? error.message : "Forecast correction could not be learned." },
        { status: 500 },
      );
    }
  };
}

export const loader = createForecastCorrectionLoader();
