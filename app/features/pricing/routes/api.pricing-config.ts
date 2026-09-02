import { data } from "react-router";
import { pricingConfigRepository } from "~/core/db";
import {
  DEFAULT_SERVER_PRICING_CONFIG,
  normalizeServerPricingConfig,
} from "~/features/pricing/types/config";

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
