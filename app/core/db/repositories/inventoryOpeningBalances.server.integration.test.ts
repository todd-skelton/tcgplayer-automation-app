import assert from "node:assert/strict";
import {quantityFingerprint} from "~/features/inventory-opening-balance/domain/inventoryObservation";
const testUrl=process.env.TEST_DATABASE_URL;
if(!testUrl) throw new Error("TEST_DATABASE_URL is required.");
const name=new URL(testUrl).pathname.replace(/^\/+/,"");
if(!name.startsWith("tcgplayer_fifo_test_")) throw new Error("A tcgplayer_fifo_test_* database is required.");
if(process.env.DATABASE_URL!==testUrl) throw new Error("DATABASE_URL must match TEST_DATABASE_URL.");
const {getPool}=await import("../database.server");
const {inventoryOpeningBalancesRepository:repo}=await import("./inventoryOpeningBalances.server");
const {inventoryBatchesRepository}=await import("./inventoryBatches.server");
const pool=getPool();
const seller=`opening-${Date.now()}`;
const started=new Date("2026-09-07T12:00:00Z");
const cutoff=new Date("2026-09-07T12:01:00Z");
try{
  await pool.query(`INSERT INTO products (product_id,product_type_name,rarity_name,sealed,product_name,set_id,set_code,set_name,product_line_id,product_status_id,product_line_name)
    VALUES (9001,'Card','Rare',false,'Card',90,'S','Set',9,1,'Game'),
      (9002,'Card','Rare',false,'Other',90,'S','Set',9,1,'Game')`);
  await pool.query(`INSERT INTO skus (sku,condition,variant,language,product_type_name,rarity_name,sealed,product_name,set_id,set_code,product_id,set_name,product_line_id,product_status_id,product_line_name)
    VALUES (99001,'Near Mint','','English','Card','Rare',false,'Card',90,'S',9001,'Set',9,1,'Game')`);
  const claim=await repo.beginObservationCapture({requestId:`${seller}-obs`,sellerKey:seller});
  assert.equal(claim.state,"claimed");
  if(claim.state!=="claimed") throw new Error("Expected observation claim.");
  const firstItems=[{sku:99001,quantity:5,productLine:"Game",setName:"Set",productName:"Card",condition:"Near Mint",variant:""}];
  const observation=await repo.recordObservation({requestId:`${seller}-obs`,sellerKey:seller,claimToken:claim.claimToken,
    beforeIdentityDeclarationCount:2,afterIdentityDeclarationCount:2,status:"complete",startedAt:started,cutoffAt:cutoff,
    quantityFingerprint:quantityFingerprint(firstItems),firstContentFingerprint:"raw-a",secondContentFingerprint:"raw-b",
    items:firstItems});
  const observationReplay=await repo.beginObservationCapture({requestId:`${seller}-obs`,sellerKey:seller});
  assert.equal(observationReplay.state,"complete");
  await assert.rejects(()=>repo.beginObservationCapture({requestId:`${seller}-obs`,sellerKey:`${seller}-other`}),/different seller/);
  const withoutCoverage=await repo.preview({requestId:`${seller}-preview-no-coverage`,sellerKey:seller,observationId:observation.id});
  assert.equal(withoutCoverage.status,"blocked");
  assert.match(withoutCoverage.unresolved.join(" "),/order coverage/);
  await pool.query(`INSERT INTO seller_order_sync_runs (seller_key,source,status,search_range,started_at,finished_at,next_offset,expected_total,pages_completed,orders_observed,details_recorded)
    VALUES ($1,'tcgplayer_api','complete','LastThreeMonths',$2,$3,0,0,1,0,0)`,[seller,cutoff,new Date("2026-09-07T12:02:00Z")]);
  await pool.query(`INSERT INTO seller_orders
    (seller_key,order_number,order_time,lifecycle,provider_status,gross_item_proceeds,source_fingerprint,
     first_observed_at,last_observed_at,detail_observed_at,latest_source)
    VALUES ($1,'interval-order',$2,'ready_to_ship','Ready to Ship',1.00,'interval-fp',$3,$3,$3,'tcgplayer_api')`,
    [seller,new Date("2026-09-07T12:00:30Z"),new Date("2026-09-07T12:02:00Z")]);
  const intervalPreview=await repo.preview({requestId:`${seller}-preview-interval`,sellerKey:seller,observationId:observation.id});
  assert.equal(intervalPreview.status,"blocked");
  assert.match(intervalPreview.unresolved.join(" "),/order occurred/);
  await pool.query(`DELETE FROM seller_orders WHERE seller_key=$1`,[seller]);
  const preview=await repo.preview({requestId:`${seller}-preview`,sellerKey:seller,observationId:observation.id});
  assert.equal(preview.status,"previewed");
  await assert.rejects(()=>repo.preview({requestId:`${seller}-preview`,sellerKey:`${seller}-other`,observationId:observation.id}),/different inputs/);
  await pool.query(`UPDATE skus SET product_id=9002 WHERE sku=99001`);
  await assert.rejects(()=>repo.apply(preview.id,preview.evidenceFingerprint,seller),/evidence changed/);
  await pool.query(`UPDATE skus SET product_id=9001 WHERE sku=99001`);
  const applied=await repo.apply(preview.id,preview.evidenceFingerprint,seller);
  assert.equal(applied.status,"applied");
  assert.equal((await repo.apply(preview.id,preview.evidenceFingerprint,seller)).status,"applied");
  await assert.rejects(()=>repo.apply(preview.id,preview.evidenceFingerprint,`${seller}-other`),/not found/);
  const opening=await pool.query(`SELECT original_quantity,product_id,receipt_kind,fifo_precedence,intake_at,market_value FROM inventory_receipts WHERE opening_balance_run_id=$1`,[preview.id]);
  assert.deepEqual(opening.rows,[{original_quantity:5,product_id:9001,receipt_kind:"opening_balance",fifo_precedence:0,intake_at:null,market_value:null}]);

  await pool.query(`INSERT INTO pending_inventory (sku,quantity,product_line_id,set_id,product_id,created_at,updated_at) VALUES (99001,2,9,90,9001,NOW(),NOW())`);
  await pool.query(`INSERT INTO inventory_pending_mutations (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
    VALUES ($1,'add',99001,2,9,90,9001,2,2)`,[`${seller}-pending`]);
  await pool.query(`INSERT INTO inventory_receipts (request_id,sku,original_quantity,product_line_id,set_id,product_id,intake_at,market_provenance)
    VALUES ($1,99001,2,9,90,9001,NOW(),'unavailable')`,[`${seller}-pending`]);
  const batch=await inventoryBatchesRepository.createFromPendingInventory(`${seller}-batch`);
  const linked=await pool.query(`SELECT receipt.receipt_kind,SUM(link.linked_quantity)::int quantity FROM inventory_receipt_batch_links link JOIN inventory_receipts receipt USING(receipt_id) WHERE link.batch_number=$1 GROUP BY receipt.receipt_kind`,[batch?.batchNumber]);
  assert.deepEqual(linked.rows,[{receipt_kind:"received",quantity:2}]);
  const openingUnlinked=await pool.query(`SELECT COUNT(*)::int count FROM inventory_receipt_batch_links link JOIN inventory_receipts receipt USING(receipt_id) WHERE receipt.receipt_kind='opening_balance'`);
  assert.equal(openingUnlinked.rows[0]?.count,0);

  const nextClaim=await repo.beginObservationCapture({requestId:`${seller}-obs-next`,sellerKey:seller});
  if(nextClaim.state!=="claimed") throw new Error("Expected next observation claim.");
  const nextItems=[{sku:99001,quantity:4,productLine:"Game",setName:"Set",productName:"Card",condition:"Near Mint",variant:""}];
  const nextObservation=await repo.recordObservation({requestId:`${seller}-obs-next`,sellerKey:seller,claimToken:nextClaim.claimToken,
    beforeIdentityDeclarationCount:2,afterIdentityDeclarationCount:2,status:"complete",
    startedAt:new Date("2026-09-07T13:00:00Z"),cutoffAt:new Date("2026-09-07T13:01:00Z"),
    quantityFingerprint:quantityFingerprint(nextItems),firstContentFingerprint:"raw-c",secondContentFingerprint:"raw-d",
    items:nextItems});
  const difference=await pool.query(`SELECT id::text AS id,status,previous_quantity,observed_quantity,quantity_delta
    FROM inventory_observation_differences WHERE observation_id=$1`,[nextObservation.id]);
  assert.deepEqual(difference.rows.map(({status,previous_quantity,observed_quantity,quantity_delta})=>({status,previous_quantity,observed_quantity,quantity_delta})),
    [{status:"unresolved",previous_quantity:5,observed_quantity:4,quantity_delta:-1}]);
  const acknowledgement={requestId:`${seller}-ack`,id:difference.rows[0].id,sellerKey:seller,note:"Count checked; cause remains unknown."};
  await repo.acknowledgeDifference(acknowledgement);
  await repo.acknowledgeDifference(acknowledgement);
  await assert.rejects(()=>repo.acknowledgeDifference({...acknowledgement,note:"Different evidence"}),/conflicts/);
  console.log("PASS opening balance applies once with unknown evidence and cannot enter pending batches");
}finally{
  await pool.query(`DELETE FROM inventory_batch_intake_requests WHERE request_id LIKE $1`,[`${seller}%`]);
  await pool.query(`DELETE FROM inventory_receipt_batch_links WHERE receipt_id IN (SELECT receipt_id FROM inventory_receipts WHERE request_id LIKE $1)`,[`${seller}%`]);
  await pool.query(`DELETE FROM inventory_opening_balance_items WHERE run_id IN (SELECT id FROM inventory_opening_balance_runs WHERE seller_key=$1)`,[seller]);
  await pool.query(`DELETE FROM inventory_receipts WHERE request_id LIKE $1 OR opening_balance_run_id IN (SELECT id FROM inventory_opening_balance_runs WHERE seller_key=$2)`,[`${seller}%`,seller]);
  await pool.query(`DELETE FROM inventory_pending_mutations WHERE request_id LIKE $1 OR request_id IN (
    SELECT 'opening:'||run.id::text||':'||item.sku::text FROM inventory_opening_balance_runs run
    JOIN inventory_complete_observation_items item ON item.observation_id=run.observation_id WHERE run.seller_key=$2)`,[`${seller}%`,seller]);
  await pool.query(`DELETE FROM inventory_batches WHERE source_request_id LIKE $1`,[`${seller}%`]);
  await pool.query(`DELETE FROM inventory_opening_balance_runs WHERE seller_key=$1`,[seller]);
  await pool.query(`DELETE FROM inventory_observation_differences WHERE seller_key=$1`,[seller]);
  await pool.query(`DELETE FROM inventory_complete_observation_items WHERE observation_id IN (SELECT id FROM inventory_complete_observations WHERE seller_key=$1)`,[seller]);
  await pool.query(`DELETE FROM inventory_complete_observation_requests WHERE seller_key=$1`,[seller]);
  await pool.query(`DELETE FROM inventory_complete_observations WHERE seller_key=$1`,[seller]);
  await pool.query(`DELETE FROM seller_orders WHERE seller_key=$1`,[seller]);
  await pool.query(`DELETE FROM seller_order_sync_runs WHERE seller_key=$1`,[seller]);
  await pool.query(`DELETE FROM skus WHERE sku=99001`);await pool.query(`DELETE FROM products WHERE product_id IN (9001,9002)`);
  await pool.end();
}
