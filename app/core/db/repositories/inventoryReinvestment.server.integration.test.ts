import assert from "node:assert/strict";
import { getDatabaseUrl, getPool, query, queryOne } from "../database.server";
import { inventoryEconomicsRepository } from "./inventoryEconomics.server";
import { inventoryReinvestmentRepository } from "./inventoryReinvestment.server";
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
const fulfillment=await inventoryEconomicsRepository.recordOrderExpense({requestId:`${prefix}-fulfillment`,sellerKey,
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

const observation=await queryOne<{id:string}>(`INSERT INTO inventory_complete_observations
  (request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,quantity_fingerprint,
   supported_quantity_fingerprint,first_content_fingerprint,second_content_fingerprint,item_count,
   positive_item_count,total_quantity,supported_positive_sku_count,supported_total_quantity,
   unsupported_positive_item_count,unsupported_positive_quantity,identity_evidence)
  VALUES ($1,$2,'seller_portal_live_export','complete','sellable_excludes_reserved',NOW(),NOW(),$3,$3,$3,$3,
    1,1,5,1,5,0,0,'{}'::jsonb) RETURNING id::text AS id`,[`${prefix}-opening-observation`,sellerKey,`${prefix}-opening-fingerprint`]);
assert.ok(observation);
const openingRun=await queryOne<{id:string}>(`INSERT INTO inventory_opening_balance_runs
  (request_id,seller_key,observation_id,cutoff_at,status,evidence_fingerprint,apply_request_id,
   validation_observation_id,validation_order_coverage_evidence,applied_at)
  VALUES ($1,$2,$3,NOW(),'applied',$4,$5,$3,'{}'::jsonb,NOW()) RETURNING id::text AS id`,
  [`${prefix}-opening-run`,sellerKey,observation.id,`${prefix}-opening-evidence`,`${prefix}-opening-apply`]);
assert.ok(openingRun);
await query(`INSERT INTO inventory_pending_mutations
  (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
  VALUES ($1,'opening',990004,5,1,1,4,5,5),($2,'add',990005,2,1,1,5,2,2)`,
  [`${prefix}-opening-receipt`,`${prefix}-targeted-received`]);
const kindReceipts=await query<{receiptId:number;receiptKind:string}>(`INSERT INTO inventory_receipts
  (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,intake_at,market_provenance,
   receipt_kind,opening_balance_run_id,fifo_precedence)
  VALUES ($1,990004,5,1,1,4,$3,NULL,'unavailable','opening_balance',$4,0),
         ($2,990005,2,1,1,5,NULL,'2026-07-02T00:00:00Z','unavailable','received',NULL,1)
  RETURNING receipt_id AS "receiptId",receipt_kind AS "receiptKind"`,
  [`${prefix}-opening-receipt`,`${prefix}-targeted-received`,sellerKey,openingRun.id]);
const targetItem=await queryOne<{id:string}>(`INSERT INTO inventory_publication_items
  (publication_id,candidate_key,inventory_delta_key,sku,product_id,product_line,set_name,product_name,condition,
   desired_price,quantity_delta,priced_at,status)
  VALUES ($1,$2,$3,990005,5,'Synthetic','Synthetic','Unknown-cost received','Near Mint',1,2,NOW(),'planned')
  RETURNING id::text AS id`,[publication.id,`${prefix}-item-targeted`,`${prefix}-delta-targeted`]);
assert.ok(targetItem);
await query(`INSERT INTO inventory_publication_receipt_links
  (publication_item_id,receipt_id,planned_quantity,target_seller_key) VALUES ($1,$2,2,$3)`,
  [targetItem.id,kindReceipts.find((row)=>row.receiptKind==="received")!.receiptId,sellerKey]);
const receiptKinds=await inventoryReinvestmentRepository.findSourceEvidence(sellerKey);
assert.equal(receiptKinds.unknownCostReceiptCount,1);
assert.equal((receiptKinds.unknownCostReceipts[0].identity as {receiptId:number}).receiptId,
  kindReceipts.find((row)=>row.receiptKind==="received")!.receiptId);
assert.equal(receiptKinds.purchaseRows.some((row)=>row.receiptId===
  kindReceipts.find((value)=>value.receiptKind==="opening_balance")!.receiptId),false);

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

await inventoryEconomicsRepository.recordOrderExpense({requestId:`${prefix}-fulfillment-correction`,sellerKey,
  expenseReference:`${prefix}-fulfillment`,currency:"USD",expenseType:"fulfillment",amountCents:0,provenance:"actual",
  orderNumbers:[`${prefix}-order`],expenseAt:"2026-07-01",basis:"additional_expense",
  correctsEntryId:fulfillment.entryId,correctionReason:"Synthetic same-effect evidence correction"});
const sameEffectCorrection=await loadReinvestmentTurnaround(sellerKey,asOf);
const currentExpense=(await inventoryEconomicsRepository.listOrderExpenses(sellerKey)).find((expense)=>expense.isCurrent)!;
assert.notEqual(sameEffectCorrection.sourceFingerprint,first.sourceFingerprint);
assert.deepEqual(sameEffectCorrection.currencies,first.currencies);
const semanticSamples=(samples:typeof first.samples)=>samples.map(({amountCents,state,receiptId})=>({amountCents,state,receiptId}))
  .sort((left,right)=>left.receiptId-right.receiptId);
assert.deepEqual(semanticSamples(sameEffectCorrection.samples),semanticSamples(first.samples));
assert.equal(sameEffectCorrection.samples.every((sample)=>sample.sourceIdentities.includes(currentExpense.evidenceIdentity)),true);
assert.equal(first.samples.some((sample)=>sample.sourceIdentities.includes(currentExpense.evidenceIdentity)),false);
assert.equal((await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM inventory_reinvestment_rebuilds WHERE seller_key=$1`,[sellerKey]))?.count,2);
assert.equal((await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM inventory_reinvestment_allocations WHERE seller_key=$1`,[sellerKey]))?.count,4);
const current=await queryOne<{sourceFingerprint:string}>(`SELECT rebuild.source_fingerprint AS "sourceFingerprint"
  FROM inventory_reinvestment_current_rebuilds current JOIN inventory_reinvestment_rebuilds rebuild ON rebuild.id=current.rebuild_id
  WHERE current.seller_key=$1`,[sellerKey]);
assert.equal(current?.sourceFingerprint,sameEffectCorrection.sourceFingerprint);

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
