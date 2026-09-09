import type { TurnaroundMode, TurnaroundSetting } from "~/features/inventory-strategy/types/turnaroundStrategy";
import { query, queryOne, withTransaction, type Queryable } from "../database.server";

interface SettingRow {
  sellerKey: string;
  productLineId: number | null;
  mode: TurnaroundMode;
  manualTurnaroundDays: number;
  updatedAt: Date;
}

function scopeKey(productLineId: number | null): string {
  return productLineId === null ? "all" : `line:${productLineId}`;
}

function mapRow(row: SettingRow): TurnaroundSetting {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

export const inventoryStrategyTurnaroundRepository = {
  async findForSeller(sellerKey: string, executor?: Queryable): Promise<TurnaroundSetting[]> {
    const seller = sellerKey.trim();
    if (!seller) return [];
    return (await query<SettingRow>(
      `SELECT seller_key AS "sellerKey",product_line_id AS "productLineId",mode,
        manual_turnaround_days::float8 AS "manualTurnaroundDays",updated_at AS "updatedAt"
       FROM inventory_strategy_turnaround_settings
       WHERE seller_key=$1 ORDER BY product_line_id NULLS FIRST`,
      [seller], executor,
    )).map(mapRow);
  },

  async saveForConfiguredSeller(input: {
    sellerKey: string;
    productLineId: number | null;
    mode: TurnaroundMode;
    manualTurnaroundDays: number;
  }): Promise<TurnaroundSetting> {
    const seller = input.sellerKey.trim();
    if (!seller) throw new Error("Seller key is required.");
    if (input.productLineId !== null && (!Number.isSafeInteger(input.productLineId) || input.productLineId <= 0)) {
      throw new Error("Product line is invalid.");
    }
    if (input.mode !== "manual" && input.mode !== "observed") throw new Error("Turnaround mode is invalid.");
    if (!Number.isFinite(input.manualTurnaroundDays) || input.manualTurnaroundDays < 0 || input.manualTurnaroundDays > 3650) {
      throw new Error("Manual turnaround must be between 0 and 3,650 days.");
    }
    return withTransaction(async (db) => {
      const configured = await queryOne<{ sellerKey: string | null }>(
        `SELECT settings_json#>>'{continuousPricing,sellerKey}' AS "sellerKey"
         FROM inventory_publication_settings WHERE config_key='default' FOR SHARE`, [], db,
      );
      if (configured?.sellerKey?.trim() !== seller) {
        throw new Error("The configured seller changed. Reload Inventory Strategy before saving.");
      }
      if (input.productLineId !== null) {
        const owned = await queryOne<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM continuous_pricing_inventory
            WHERE seller_key=$1 AND product_line_id=$2) AS "exists"`,
          [seller, input.productLineId], db,
        );
        if (!owned?.exists) throw new Error("This product line is not available for the configured seller.");
      }
      const row = await queryOne<SettingRow>(
        `INSERT INTO inventory_strategy_turnaround_settings
          (seller_key,scope_key,product_line_id,mode,manual_turnaround_days)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (seller_key,scope_key) DO UPDATE SET
           product_line_id=EXCLUDED.product_line_id,mode=EXCLUDED.mode,
           manual_turnaround_days=EXCLUDED.manual_turnaround_days,updated_at=NOW()
         RETURNING seller_key AS "sellerKey",product_line_id AS "productLineId",mode,
           manual_turnaround_days::float8 AS "manualTurnaroundDays",updated_at AS "updatedAt"`,
        [seller, scopeKey(input.productLineId), input.productLineId, input.mode, input.manualTurnaroundDays], db,
      );
      if (!row) throw new Error("Turnaround setting could not be saved.");
      return mapRow(row);
    });
  },
};
