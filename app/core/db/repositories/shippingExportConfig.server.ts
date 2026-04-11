import type { ShippingExportConfig } from "~/features/shipping-export/types/shippingExport";
import { asJson, execute, queryOne, type Queryable } from "../database.server";

type ShippingExportConfigRow = {
  settings: ShippingExportConfig;
  updatedAt: Date;
};

const CONFIG_KEY = "default";

export const shippingExportConfigRepository = {
  async get(executor?: Queryable): Promise<ShippingExportConfigRow | null> {
    return queryOne<ShippingExportConfigRow>(
      `SELECT
        settings_json AS "settings",
        updated_at AS "updatedAt"
      FROM shipping_export_config
      WHERE config_key = $1`,
      [CONFIG_KEY],
      executor,
    );
  },

  async save(
    config: ShippingExportConfig,
    executor?: Queryable,
  ): Promise<void> {
    await execute(
      `INSERT INTO shipping_export_config (
        config_key,
        settings_json,
        updated_at
      ) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (config_key) DO UPDATE SET
        settings_json = EXCLUDED.settings_json,
        updated_at = NOW()`,
      [CONFIG_KEY, asJson(config)],
      executor,
    );
  },
};
