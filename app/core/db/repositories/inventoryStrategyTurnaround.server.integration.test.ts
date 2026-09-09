import assert from "node:assert/strict";
import { getDatabaseUrl, getPool, query, queryOne } from "../database.server";
import { inventoryPublicationSettingsRepository } from "./inventoryPublicationSettings.server";
import { inventoryStrategyTurnaroundRepository } from "./inventoryStrategyTurnaround.server";

const databaseName = new URL(getDatabaseUrl()).pathname.slice(1);
if (!databaseName.startsWith("tcgplayer_strategy_test_")) {
  throw new Error("Turnaround settings integration tests require a disposable tcgplayer_strategy_test_* database.");
}

const original = await inventoryPublicationSettingsRepository.get();
const sellerKey = `synthetic-turnaround-settings-${Date.now()}`;
const otherSeller = `${sellerKey}-other`;
const productLineId = 9_680_001;
const sku = 9_680_001;
try {
  await inventoryPublicationSettingsRepository.save({
    ...original.settings,
    continuousPricing: { ...original.settings.continuousPricing, sellerKey },
  });
  await query(
    `INSERT INTO continuous_pricing_inventory
      (seller_key,sku,product_id,product_line_id,set_id,product_line,set_name,product_name,
       condition,quantity,current_price,last_observed_at)
     VALUES ($1,$2,$2,$3,$2,'Synthetic','Synthetic','Synthetic','Near Mint',1,1,NOW())`,
    [sellerKey, sku, productLineId],
  );
  const pricingBefore = await queryOne<{ pricing: unknown }>(
    `SELECT pricing_json AS pricing FROM pricing_config WHERE config_key='default'`,
  );
  const seller = await inventoryStrategyTurnaroundRepository.saveForConfiguredSeller({
    sellerKey, productLineId: null, mode: "manual", manualTurnaroundDays: 28,
  });
  assert.equal(seller.manualTurnaroundDays, 28);
  const line = await inventoryStrategyTurnaroundRepository.saveForConfiguredSeller({
    sellerKey, productLineId, mode: "observed", manualTurnaroundDays: 31,
  });
  assert.equal(line.mode, "observed");
  assert.equal(line.productLineId, productLineId);
  assert.deepEqual((await inventoryStrategyTurnaroundRepository.findForSeller(sellerKey))
    .map((setting) => [setting.productLineId, setting.mode, setting.manualTurnaroundDays]), [
      [null, "manual", 28],
      [productLineId, "observed", 31],
    ]);
  assert.deepEqual((await queryOne<{ pricing: unknown }>(
    `SELECT pricing_json AS pricing FROM pricing_config WHERE config_key='default'`,
  ))?.pricing, pricingBefore?.pricing, "strategy settings must not mutate active pricing configuration");

  await inventoryPublicationSettingsRepository.save({
    ...original.settings,
    continuousPricing: { ...original.settings.continuousPricing, sellerKey: otherSeller },
  });
  await assert.rejects(
    inventoryStrategyTurnaroundRepository.saveForConfiguredSeller({
      sellerKey, productLineId: null, mode: "observed", manualTurnaroundDays: 14,
    }),
    /configured seller changed/i,
  );
  assert.equal((await inventoryStrategyTurnaroundRepository.findForSeller(otherSeller)).length, 0,
    "another seller must not inherit the prior seller's setting");
  console.log("PASS turnaround settings persist by seller and product line without mutating pricing");
} finally {
  await query(`DELETE FROM inventory_strategy_turnaround_settings WHERE seller_key=ANY($1::text[])`, [[sellerKey, otherSeller]]);
  await query(`DELETE FROM continuous_pricing_inventory WHERE seller_key=$1 AND sku=$2`, [sellerKey, sku]);
  await inventoryPublicationSettingsRepository.save(original.settings);
  await getPool().end();
}
