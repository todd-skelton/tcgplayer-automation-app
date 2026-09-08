import assert from "node:assert/strict";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || process.env.DATABASE_URL !== testUrl) throw new Error("DATABASE_URL and TEST_DATABASE_URL must match.");
if (!new URL(testUrl).pathname.replace(/^\/+/, "").startsWith("tcgplayer_fifo_test_")) throw new Error("A disposable tcgplayer_fifo_test_* database is required.");

const { getPool } = await import("~/core/db/database.server");
const { enrichShippingOrdersWithIntakeHistory } = await import("./shippingIntakeHistory.server");
const pool = getPool();
const seller = `shipping-history-${Date.now()}`;
const sku = 99101;
const sale = new Date("2026-08-01T12:00:00.000Z");

try {
  await pool.query(`INSERT INTO products(product_id,product_type_name,rarity_name,sealed,product_name,set_id,set_code,set_name,
    product_line_id,product_status_id,product_line_name) VALUES(99103,'Card','Rare',false,'Synthetic',99102,'S','Set',99100,1,'Game')
    ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO skus(sku,condition,variant,language,product_type_name,rarity_name,sealed,product_name,set_id,set_code,
    product_id,set_name,product_line_id,product_status_id,product_line_name)
    VALUES($1,'Near Mint','Normal','English','Card','Rare',false,'Synthetic',99102,'S',99103,'Set',99100,1,'Game') ON CONFLICT DO NOTHING`,[sku]);
  const order = (await pool.query(`INSERT INTO seller_orders(seller_key,order_number,order_time,lifecycle,provider_status,
    gross_item_proceeds,source_fingerprint,first_observed_at,last_observed_at,detail_observed_at,latest_source)
    VALUES($1,'A',$2,'ready_to_ship','Ready to Ship',20,'fp',NOW(),NOW(),NOW(),'tcgplayer_api') RETURNING id`,[seller,sale])).rows[0];
  await pool.query(`INSERT INTO seller_order_lines(order_id,sku_id,product_name,ordered_quantity,gross_item_proceeds)
    VALUES($1,$2,'Synthetic',3,20)`,[order.id,String(sku)]);
  await pool.query(`INSERT INTO seller_order_revisions(order_id,revision_number,source_fingerprint,source,observed_at,order_time,
    order_time_evidence,provider_status,lifecycle,line_evidence) VALUES($1,1,'fp','tcgplayer_api',NOW(),$2,
    'detail_canonical','Ready to Ship','ready_to_ship','[]')`,[order.id,sale]);
  const receipts: number[] = [];
  for (const [index, value] of [{ quantity: 2, market: 4, days: 60 }, { quantity: 1, market: 6, days: 10 }].entries()) {
    const requestId = `${seller}-receipt-${index}`;
    await pool.query(`INSERT INTO inventory_pending_mutations(request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,
      product_id,quantity_delta,resulting_quantity) VALUES($1,'add',$2,$3,99100,99102,99103,$3,$3)`,[requestId,sku,value.quantity]);
    const receipt = await pool.query(`INSERT INTO inventory_receipts(request_id,sku,original_quantity,product_line_id,set_id,product_id,
      seller_key,intake_at,market_value,market_provenance) VALUES($1,$2,$3,99100,99102,99103,$4,$5,$6,'tcgplayer_price_points')
      RETURNING receipt_id`,[requestId,sku,value.quantity,seller,new Date(sale.getTime() - value.days * 86_400_000),value.market]);
    receipts.push(receipt.rows[0]!.receipt_id);
  }
  const fifo = (await pool.query(`INSERT INTO inventory_fifo_lines(seller_key,order_id,order_line_sku_id,sku,order_time,ordered_quantity,
    source_order_revision,state,matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity,intake_market_total,weighted_days_held)
    VALUES($1,$2,$3,$4,$5,3,1,'allocated',3,0,3,3,14,43.333333) RETURNING id`,[seller,order.id,String(sku),sku,sale])).rows[0];
  const revision = (await pool.query(`INSERT INTO inventory_fifo_revisions(line_id,revision_number,source_order_revision,order_time,
    trigger_reason,state,ordered_quantity,matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity,
    intake_market_total,weighted_days_held,source_fingerprint) VALUES($1,1,1,$2,'test','allocated',3,3,0,3,3,14,43.333333,'fp') RETURNING id`,
    [fifo.id,sale])).rows[0];
  await pool.query(`UPDATE inventory_fifo_lines SET current_revision_id=$2 WHERE id=$1`,[fifo.id,revision.id]);
  await pool.query(`INSERT INTO inventory_fifo_revision_allocations(revision_id,supply_key,receipt_id,allocated_quantity,available_at)
    VALUES($1,$2,$3,2,$4),($1,$5,$6,1,$4)`,[revision.id,`receipt:${receipts[0]}`,receipts[0],sale,`receipt:${receipts[1]}`,receipts[1]]);

  const shippingOrder = { "Order #": "A", FirstName: "", LastName: "", Address1: "", Address2: "", City: "", State: "",
    PostalCode: "", Country: "US", "Order Date": sale.toISOString(), "Product Weight": 0, "Shipping Method": "Standard" as const,
    "Item Count": 3, "Value Of Products": 20, "Shipping Fee Paid": 0, "Tracking #": "", Carrier: "", products: [
      { name: "first", quantity: 2, unitPrice: 5, inventorySkuId: String(sku), skuId: sku },
      { name: "second", quantity: 1, unitPrice: 10, inventorySkuId: String(sku), skuId: sku },
    ] };
  const enriched = await enrichShippingOrdersWithIntakeHistory([shippingOrder], seller);
  const line = enriched[0]!.intakeHistory!.lines[0]!;
  assert.deepEqual([line.status,line.intakeMarketTotal,line.priceKnownQuantity,line.dateKnownQuantity,line.lots.length],
    ["current",14,3,3,2]);
  assert.ok(Math.abs((line.weightedDaysHeld ?? 0) - 43.333333) < 0.000001);
  assert.equal((await enrichShippingOrdersWithIntakeHistory([shippingOrder], `${seller}-other`))[0]!.intakeHistory!.lines[0]!.status,
    "unavailable");
  console.log("PASS shipping intake history reads mixed FIFO lots in one seller-scoped bulk projection");
} finally {
  await pool.end();
}
