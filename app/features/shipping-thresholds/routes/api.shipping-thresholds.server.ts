import { data, type LoaderFunctionArgs } from "react-router";
import { pricingConfigRepository } from "~/core/db";
import { SHIPPING_EVIDENCE_WINDOW_DAYS } from "~/features/pricing/types/config";
import { loadShippingThresholdReport } from "../services/shippingThresholds.server";

export function createShippingThresholdsLoader(dependencies = {
  getConfig: () => pricingConfigRepository.get(),
  load: loadShippingThresholdReport,
}) {
  return async function shippingThresholdsLoader({ request }: LoaderFunctionArgs) {
    try {
      const config = await dependencies.getConfig();
      const settings = config.pricing.shippingThresholdSnaps;
      const requested = new URL(request.url).searchParams.get("days");
      const days = requested === null ? settings.evidenceWindowDays : Number(requested);
      if (!SHIPPING_EVIDENCE_WINDOW_DAYS.some((allowed) => allowed === days)) {
        return data(
          { error: `days must be one of ${SHIPPING_EVIDENCE_WINDOW_DAYS.join(", ")}.` },
          { status: 400 },
        );
      }
      return data(await dependencies.load(settings, config.pricing.profitPerDay.relativeOverhead, days));
    } catch (error) {
      console.error("Shipping threshold report failed", error);
      return data(
        { error: error instanceof Error ? error.message : "Shipping threshold report could not be loaded." },
        { status: 500 },
      );
    }
  };
}

export const loader = createShippingThresholdsLoader();
