import assert from "node:assert/strict";
import { getDatabaseUrl, getPool, query, queryOne } from "../database.server";
import { inventoryEconomicsRepository } from "./inventoryEconomics.server";
import { loadReinvestmentTurnaround } from "~/features/inventory-strategy/services/reinvestmentTurnaround.server";

const databaseName=new URL(getDatabaseUrl()).pathname.slice(1);
if (!databaseName.startsWith("tcgplayer_strategy_test_")) {
  throw new Error("Reinvestment integration tests require a disposable tcgplayer_strategy_test_* database.");
}

const prefix=`synthetic-reinvestment-${Date.now()}`;
const sellerKey=`${prefix}-seller`;
const batchNumber=1_000_000+(Date.now()%1_000_000);
const order=await queryOne<{id:string}>(`INSERT INTO seller_orders
  (seller_key,order_number,order_time,lifecycle,provider_status,refund_status,gross_item_proceeds,currency,
   source_revision,source_fingerprint,first_observed_at,last_observed_at,detail_observed_at,latest_source,
   gross_shipping_proceeds,gross_order_proceeds,platform_fee_amount,provider_net_proceeds,direct_fee_amount,transaction_evidence)
  VALUES ($1,$2,'2026-07-01T00:00:00Z','completed_paid','Completed','No Refund',100,'USD',1,$3,NOW(),NOW(),NOW(),
    'file_import',0,100,0,100,0,'{}'::jsonb) RETURNING id::text AS id`,[sellerKey,`${prefix}-order`,`${prefix}-source-1`]);
assert.ok(order);
await query(`INSERT INTO seller_order_lines (order_id,sku_id,product_name,ordered_quantity,gross_item_proceeds)
  VALUES ($1,'990001','Synthetic sold card',1,100)`,[order.id]);
await query(`INSERT INTO seller_order_revisions
  (order_id,revision_number,source_fingerprint,source,observed_at,provider_status,lifecycle,refund_status,
   refund_evidence,line_evidence,transaction_evidence,order_time,order_time_evidence)
  VALUES ($1,1,$2,'file_import',NOW(),'Completed','completed_paid','No Refund','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,
    '2026-07-01T00:00:00Z','detail_canonical')`,[order.id,`${prefix}-source-1`]);
await inventoryEconomicsRepository.recordOrderExpense({requestId:`${prefix}-fulfillment`,sellerKey,
  expenseReference:`${prefix}-fulfillment`,currency:"USD",expenseType:"fulfillment",amountCents:0,provenance:"actual",
  orderNumbers:[`${prefix}-order`],expenseAt:"2026-07-01",basis:"additional_expense"});

await query(`INSERT INTO inventory_pending_mutations
  (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
  VALUES ($1,'add',990002,6,1,1,1,6,6),($2,'add',990003,4,1,1,2,4,4)`,[`${prefix}-receipt-1`,`${prefix}-receipt-2`]);
const receipts=await query<{receiptId:number}>(`INSERT INTO inventory_receipts
  (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,intake_at,market_provenance)
  VALUES ($1,990002,6,1,1,1,$3,'2026-07-02T00:00:00Z','unavailable'),
         ($2,990003,4,1,1,2,$3,'2026-07-02T00:00:00Z','unavailable')
  RETURNING receipt_id AS "receiptId"`,[`${prefix}-receipt-1`,`${prefix}-receipt-2`,sellerKey]);
await query(`INSERT INTO inventory_receipt_batch_links (receipt_id,batch_number,linked_quantity)
  VALUES ($1,$3,6),($2,$3,4)`,[receipts[0].receiptId,receipts[1].receiptId,batchNumber]);
await inventoryEconomicsRepository.recordPurchaseCost({requestId:`${prefix}-cost`,sellerKey,
  purchaseReference:`${prefix}-purchase`,currency:"USD",totalAmountCents:10_000,provenance:"actual",source:"manual",
  allocationRule:"quantity",batchNumbers:[batchNumber],purchasedAt:"2026-07-02"});

const publication=await queryOne<{id:string}>(`INSERT INTO inventory_publications
  (planning_key,method,source_type,seller_key,status) VALUES ($1,'staged_delta','pending_inventory',$2,'publishing')
  RETURNING id::text AS id`,[`${prefix}-publication`,sellerKey]);
assert.ok(publication);
const items=await query<{id:string}>(`INSERT INTO inventory_publication_items
  (publication_id,candidate_key,inventory_delta_key,sku,product_id,product_line,set_name,product_name,condition,
   desired_price,quantity_delta,priced_at,status,published_at)
  VALUES ($1,$2,$3,990002,1,'Synthetic','Synthetic','Replacement six','Near Mint',1,6,NOW(),'published','2026-07-11T00:00:00Z'),
         ($1,$4,$5,990003,2,'Synthetic','Synthetic','Replacement four','Near Mint',1,4,NOW(),'planned',NULL)
  RETURNING id::text AS id`,[publication.id,`${prefix}-item-1`,`${prefix}-delta-1`,`${prefix}-item-2`,`${prefix}-delta-2`]);
await query(`INSERT INTO inventory_publication_receipt_links
  (publication_item_id,receipt_id,planned_quantity,target_seller_key,live_at,activated_at,confirmation_evidence)
  VALUES ($1,$2,6,$4,'2026-07-11T00:00:00Z',NOW(),'{"source":"synthetic-test"}'::jsonb),
         ($3,$5,4,$4,NULL,NULL,NULL)`,[items[0].id,receipts[0].receiptId,items[1].id,sellerKey,receipts[1].receiptId]);

const beforeQuantity=await query(`SELECT original_quantity FROM inventory_receipts WHERE receipt_id=ANY($1::int[]) ORDER BY receipt_id`,[receipts.map((row)=>row.receiptId)]);
const asOf=new Date("2026-07-15T00:00:00.000Z");
const first=await loadReinvestmentTurnaround(sellerKey,asOf);
assert.equal(first.currencies[0].completedCents,6_000);
assert.equal(first.currencies[0].waitingCents,4_000);
assert.equal(first.currencies[0].completedDollarWeightedMeanDays,10);
assert.equal(first.currencies[0].completionCoveragePercent,60);
const repeated=await loadReinvestmentTurnaround(sellerKey,asOf);
assert.equal(repeated.sourceFingerprint,first.sourceFingerprint);
assert.equal((await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM inventory_reinvestment_rebuilds WHERE seller_key=$1`,[sellerKey]))?.count,1);
assert.equal((await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM inventory_reinvestment_allocations WHERE seller_key=$1`,[sellerKey]))?.count,2);

await query(`INSERT INTO seller_order_revisions
  (order_id,revision_number,source_fingerprint,source,observed_at,provider_status,lifecycle,refund_status,
   refund_evidence,line_evidence,transaction_evidence,order_time,order_time_evidence)
  VALUES ($1,2,$2,'file_import',NOW(),'Completed','completed_paid','No Refund','[]'::jsonb,'[]'::jsonb,'{"corrected":true}'::jsonb,
    '2026-07-01T00:00:00Z','detail_canonical')`,[order.id,`${prefix}-source-2`]);
await query(`UPDATE seller_orders SET source_revision=2,source_fingerprint=$2,platform_fee_amount=20,
  provider_net_proceeds=80,transaction_evidence='{"corrected":true}'::jsonb WHERE id=$1`,[order.id,`${prefix}-source-2`]);
const corrected=await loadReinvestmentTurnaround(sellerKey,asOf);
assert.notEqual(corrected.sourceFingerprint,first.sourceFingerprint);
assert.equal(corrected.currencies[0].completedCents,4_800);
assert.equal(corrected.currencies[0].waitingCents,3_200);
assert.equal(corrected.currencies[0].unresolvedPurchaseCostCents,2_000);
assert.deepEqual(await query(`SELECT original_quantity FROM inventory_receipts WHERE receipt_id=ANY($1::int[]) ORDER BY receipt_id`,[receipts.map((row)=>row.receiptId)]),beforeQuantity);
console.log("PASS reinvestment repository persists exact partial allocations, reuses identical rebuilds, and invalidates corrected sources without quantity writes");
await getPool().end();
