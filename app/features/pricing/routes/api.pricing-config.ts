import { data } from "react-router";
import { pricingConfigRepository } from "~/core/db";
import {
  DEFAULT_PRODUCT_LINE_PRICING_CONFIG,
  DEFAULT_PRICING_CONFIG,
  DEFAULT_SERVER_PRICING_CONFIG,
  DEFAULT_SUPPLY_ANALYSIS_CONFIG,
  type ServerPricingConfig,
} from "~/features/pricing/types/config";

function normalizeServerPricingConfig(value: unknown): ServerPricingConfig {
  const raw = (value ?? {}) as Partial<ServerPricingConfig>;

  return {
    pricing: {
      ...DEFAULT_PRICING_CONFIG,
      ...(raw.pricing ?? {}),
      successRateThreshold: {
        ...DEFAULT_PRICING_CONFIG.successRateThreshold,
        ...(raw.pricing?.successRateThreshold ?? {}),
      },
    },
    supplyAnalysis: {
      ...DEFAULT_SUPPLY_ANALYSIS_CONFIG,
      ...(raw.supplyAnalysis ?? {}),
    },
    productLinePricing: {
      ...DEFAULT_PRODUCT_LINE_PRICING_CONFIG,
      ...(raw.productLinePricing ?? {}),
      productLineSettings: raw.productLinePricing?.productLineSettings ?? {},
    },
  };
}

export async function loader() {
  try {
    const config = await pricingConfigRepository.get();
    return data(config, { status: 200 });
  } catch (error) {
    return data(
      {
        ...DEFAULT_SERVER_PRICING_CONFIG,
        error: String(error),
      },
      { status: 500 },
    );
  }
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method !== "PUT") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const payload = normalizeServerPricingConfig(await request.json());
    await pricingConfigRepository.save(payload);
    const savedConfig = await pricingConfigRepository.get();
    return data(savedConfig, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}
