import type { ServerPricingConfig } from "~/features/pricing/types/config";
import { DEFAULT_SERVER_PRICING_CONFIG } from "~/features/pricing/types/config";
import { asJson, execute, queryOne, type Queryable } from "../database.server";

type PricingConfigRow = ServerPricingConfig & {
  updatedAt: Date;
};

const CONFIG_KEY = "default";

export const pricingConfigRepository = {
  async get(executor?: Queryable): Promise<PricingConfigRow> {
    const config = await queryOne<PricingConfigRow>(
      `SELECT
        pricing_json AS "pricing",
        supply_analysis_json AS "supplyAnalysis",
        product_line_pricing_json AS "productLinePricing",
        updated_at AS "updatedAt"
      FROM pricing_config
      WHERE config_key = $1`,
      [CONFIG_KEY],
      executor,
    );

    if (config) {
      return config;
    }

    await this.save(DEFAULT_SERVER_PRICING_CONFIG, executor);

    return {
      ...DEFAULT_SERVER_PRICING_CONFIG,
      updatedAt: new Date(),
    };
  },

  async save(config: ServerPricingConfig, executor?: Queryable): Promise<void> {
    await execute(
      `INSERT INTO pricing_config (
        config_key,
        pricing_json,
        supply_analysis_json,
        product_line_pricing_json,
        updated_at
      ) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, NOW())
      ON CONFLICT (config_key) DO UPDATE SET
        pricing_json = EXCLUDED.pricing_json,
        supply_analysis_json = EXCLUDED.supply_analysis_json,
        product_line_pricing_json = EXCLUDED.product_line_pricing_json,
        updated_at = NOW()`,
      [
        CONFIG_KEY,
        asJson(config.pricing),
        asJson(config.supplyAnalysis),
        asJson(config.productLinePricing),
      ],
      executor,
    );
  },
};
