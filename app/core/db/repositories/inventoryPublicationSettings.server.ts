import { normalizeInventoryPublicationSettings } from "~/features/inventory-publication/services/inventoryPublicationSettings";
import {
  DEFAULT_INVENTORY_PUBLICATION_SETTINGS,
  type InventoryPublicationConfiguration,
  type InventoryPublicationSettings,
} from "~/features/inventory-publication/types/inventoryPublicationSettings";
import { asJson, execute, queryOne, type Queryable } from "../database.server";

const CONFIG_KEY = "default";

interface InventoryPublicationSettingsRow {
  settings: unknown;
  authenticationStatus: InventoryPublicationConfiguration["runtime"]["authenticationStatus"];
  circuitOpen: boolean;
  consecutiveFailures: number;
  pauseReason: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  updatedAt: Date;
  runtimeUpdatedAt: Date;
}

async function ensureSettings(executor?: Queryable): Promise<void> {
  await execute(
    `INSERT INTO inventory_publication_settings (
      config_key,
      settings_json
    ) VALUES ($1, $2::jsonb)
    ON CONFLICT (config_key) DO NOTHING`,
    [CONFIG_KEY, asJson(DEFAULT_INVENTORY_PUBLICATION_SETTINGS)],
    executor,
  );
}

function mapConfiguration(
  row: InventoryPublicationSettingsRow,
): InventoryPublicationConfiguration {
  return {
    settings: normalizeInventoryPublicationSettings(row.settings),
    runtime: {
      authenticationStatus: row.authenticationStatus,
      circuitOpen: row.circuitOpen,
      consecutiveFailures: row.consecutiveFailures,
      pauseReason: row.pauseReason,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      runtimeUpdatedAt: row.runtimeUpdatedAt,
    },
    updatedAt: row.updatedAt,
  };
}

async function loadConfiguration(
  executor?: Queryable,
): Promise<InventoryPublicationConfiguration> {
  const row = await queryOne<InventoryPublicationSettingsRow>(
    `SELECT
      settings_json AS "settings",
      authentication_status AS "authenticationStatus",
      circuit_open AS "circuitOpen",
      consecutive_failures AS "consecutiveFailures",
      pause_reason AS "pauseReason",
      last_success_at AS "lastSuccessAt",
      last_failure_at AS "lastFailureAt",
      updated_at AS "updatedAt",
      runtime_updated_at AS "runtimeUpdatedAt"
    FROM inventory_publication_settings
    WHERE config_key = $1`,
    [CONFIG_KEY],
    executor,
  );

  if (!row) {
    throw new Error("Inventory publication settings could not be initialized.");
  }

  return mapConfiguration(row);
}

export const inventoryPublicationSettingsRepository = {
  async get(executor?: Queryable): Promise<InventoryPublicationConfiguration> {
    await ensureSettings(executor);
    return loadConfiguration(executor);
  },

  async save(
    input: InventoryPublicationSettings,
    executor?: Queryable,
  ): Promise<InventoryPublicationConfiguration> {
    const settings = normalizeInventoryPublicationSettings(input);
    await execute(
      `INSERT INTO inventory_publication_settings (
        config_key,
        settings_json,
        updated_at
      ) VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (config_key) DO UPDATE SET
        settings_json = EXCLUDED.settings_json,
        updated_at = NOW()`,
      [CONFIG_KEY, asJson(settings)],
      executor,
    );
    return loadConfiguration(executor);
  },

  async recordSuccess(
    executor?: Queryable,
  ): Promise<InventoryPublicationConfiguration> {
    await ensureSettings(executor);
    await execute(
      `UPDATE inventory_publication_settings
      SET authentication_status = 'healthy',
          circuit_open = FALSE,
          consecutive_failures = 0,
          pause_reason = NULL,
          last_success_at = NOW(),
          runtime_updated_at = NOW()
      WHERE config_key = $1`,
      [CONFIG_KEY],
      executor,
    );
    return loadConfiguration(executor);
  },

  async recordFailure(
    input: {
      authenticationFailure: boolean;
      message: string;
      consecutiveFailureLimit: number;
    },
    executor?: Queryable,
  ): Promise<InventoryPublicationConfiguration> {
    await ensureSettings(executor);
    await execute(
      `UPDATE inventory_publication_settings
      SET authentication_status = CASE
            WHEN $2 THEN 'invalid'
            ELSE authentication_status
          END,
          consecutive_failures = consecutive_failures + 1,
          circuit_open = $2
            OR consecutive_failures + 1 >= $3,
          pause_reason = CASE
            WHEN $2 THEN 'Seller Portal authentication requires attention.'
            WHEN consecutive_failures + 1 >= $3 THEN $4
            ELSE pause_reason
          END,
          last_failure_at = NOW(),
          runtime_updated_at = NOW()
      WHERE config_key = $1`,
      [
        CONFIG_KEY,
        input.authenticationFailure,
        input.consecutiveFailureLimit,
        input.message.slice(0, 1_000),
      ],
      executor,
    );
    return loadConfiguration(executor);
  },

  async resume(
    executor?: Queryable,
  ): Promise<InventoryPublicationConfiguration> {
    await ensureSettings(executor);
    await execute(
      `UPDATE inventory_publication_settings
      SET authentication_status = CASE
            WHEN authentication_status = 'invalid' THEN 'unknown'
            ELSE authentication_status
          END,
          circuit_open = FALSE,
          consecutive_failures = 0,
          pause_reason = NULL,
          runtime_updated_at = NOW()
      WHERE config_key = $1`,
      [CONFIG_KEY],
      executor,
    );
    return loadConfiguration(executor);
  },
};
