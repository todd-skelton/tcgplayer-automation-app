import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const testUrl=process.env.TEST_DATABASE_URL;
if(!testUrl)throw new Error("TEST_DATABASE_URL is required before listing history coverage tests.");
const databaseName=new URL(testUrl).pathname.replace(/^\/+/,"");
if(!databaseName.startsWith("tcgplayer_fifo_test_"))throw new Error("Listing history coverage tests require a tcgplayer_fifo_test_* database.");
if(process.env.DATABASE_URL!==testUrl)throw new Error("DATABASE_URL must exactly match TEST_DATABASE_URL.");

const {getPool}=await import("../database.server");
const {inventoryFifoRepository:repo}=await import("./inventoryFifo.server");
const {inventorySellingHistoryRepository}=await import("./inventorySellingHistory.server");
const {DEFAULT_SELLING_HISTORY_SCOPE}=await import("~/features/inventory-strategy/types/inventorySellingHistory");
const pool=getPool();
const seller=`listing-history-${Date.now()}`;
const cutoff=new Date("2026-09-08T00:00:00Z");
const listedAt=new Date("2026-08-10T12:00:00Z");
const pricedAt=new Date("2026-08-10T11:50:00Z");
const marketDataAt=new Date("2026-08-10T11:00:00Z");
const migrationSql=await fs.readFile(path.resolve(process.cwd(),"db/migrations/045_backfill_listing_history_coverage.sql"),"utf8");
const dayMs=86_400_000;

async function addOrder(number:string,time:string,quantity:number,skuId:string,lifecycle="completed_paid"){
  const inserted=await pool.query(`INSERT INTO seller_orders
    (seller_key,order_number,order_time,lifecycle,provider_status,gross_item_proceeds,source_fingerprint,
     first_observed_at,last_observed_at,detail_observed_at,latest_source)
    VALUES ($1,$2,$3,$4,$4,1,'fp',NOW(),NOW(),NOW(),'tcgplayer_api') RETURNING id::text AS id`,
    [seller,number,time,lifecycle]);
  const id=inserted.rows[0]!.id as string;
  await pool.query(`INSERT INTO seller_order_lines
    (order_id,sku_id,product_name,ordered_quantity,gross_item_proceeds) VALUES ($1,$2,'Synthetic',$3,1)`,[id,skuId,quantity]);
  await pool.query(`INSERT INTO seller_order_revisions
    (order_id,revision_number,source_fingerprint,source,observed_at,order_time,provider_status,lifecycle,line_evidence)
    VALUES ($1,1,'fp','tcgplayer_api',NOW(),$2,$3,$3,$4::jsonb)`,[id,time,lifecycle,JSON.stringify([{skuId,quantity}])]);
  await repo.enqueueOrderRevision(id);
  return id;
}

async function addLegacyPublication(batchNumber:number,sku:number,quantity:number,marketPrice:number|null,sellerKey:string|null){
  await pool.query(`INSERT INTO inventory_batch_items
    (batch_number,sku,add_to_quantity,product_line_id,set_id,product_id,created_at,updated_at)
    VALUES ($1,$2,$3,3,7,11,NOW(),NOW())`,[batchNumber,sku,quantity]);
  await pool.query(`INSERT INTO inventory_batch_results
    (batch_number,sku,result_status,row_json,pricing_details_json,priced_at)
    VALUES ($1,$2,'successful',$3::jsonb,$4::jsonb,$5)`,[batchNumber,sku,
      JSON.stringify(marketPrice===null?{}:{"TCG Market Price":marketPrice.toFixed(2)}),
      JSON.stringify({schemaVersion:2,pricedAt:pricedAt.toISOString(),marketplacePrice:marketPrice===null?8:marketPrice*1.3,
        ...(marketPrice===null?{}:{tcgMarketPrice:marketPrice,marketDataAt:marketDataAt.toISOString()})}),pricedAt]);
  const publication=await pool.query(`INSERT INTO inventory_publications
    (planning_key,batch_number,method,source_type,seller_key,status,published_at,completed_at)
    VALUES ($1,$2,'staged_delta','pending_inventory',$3,'published',$4,$4) RETURNING id::text AS id`,
    [`${seller}:publication:${sku}`,batchNumber,sellerKey,listedAt]);
  const item=await pool.query(`INSERT INTO inventory_publication_items
    (publication_id,candidate_key,inventory_delta_key,batch_number,sku,product_id,product_line,set_name,product_name,
     condition,desired_price,quantity_delta,priced_at,status,published_at)
    VALUES ($1,$2,$3,$4,$5,11,'Pokemon','Synthetic Set','Synthetic Card','Near Mint',9.99,$6,$7,'published',$8)
    RETURNING id::text AS id`,[publication.rows[0]!.id,`pricing-result:${batchNumber}:${sku}:${pricedAt.toISOString()}`,
      `${seller}:delta:${sku}`,batchNumber,sku,quantity,pricedAt,listedAt]);
  return item.rows[0]!.id as string;
}

async function runMigration(){
  const client=await pool.connect();
  try{await client.query("BEGIN");await client.query(migrationSql);await client.query("COMMIT");}
  catch(error){await client.query("ROLLBACK");throw error;}
  finally{client.release();}
}

const receiptNumber=(key:string)=>Number(key.split(":")[1]);

async function counts(){
  const row=await pool.query(`SELECT
    (SELECT COUNT(*) FROM inventory_receipts WHERE seller_key=$1)::int AS receipts,
    (SELECT COUNT(*) FROM inventory_publication_receipt_links WHERE target_seller_key=$1)::int AS links,
    (SELECT COUNT(*) FROM inventory_listing_history_coverage WHERE seller_key=$1)::int AS coverage,
    (SELECT COALESCE(SUM(generation),0) FROM inventory_fifo_replay_queue WHERE seller_key=$1)::int AS generations`,[seller]);
  return row.rows[0]!;
}

try{
  const observation=await pool.query(`INSERT INTO inventory_complete_observations
    (request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,quantity_fingerprint,
     supported_quantity_fingerprint,first_content_fingerprint,second_content_fingerprint,item_count,
     positive_item_count,total_quantity,supported_positive_sku_count,supported_total_quantity,
     unsupported_positive_item_count,unsupported_positive_quantity,identity_evidence)
    VALUES ($1,$2,'seller_portal_live_export','complete','sellable_excludes_reserved',$3,$3,'q','s','a','b',1,1,2,1,2,0,0,'{}')
    RETURNING id::text AS id`,[`${seller}-observation`,seller,cutoff]);
  const opening=await pool.query(`INSERT INTO inventory_opening_balance_runs
    (request_id,seller_key,observation_id,cutoff_at,status,evidence_fingerprint,apply_request_id,
     validation_observation_id,validation_order_coverage_evidence,applied_at)
    VALUES ($1,$2,$3,$4,'applied','opening-fp',$5,$3,'{}',NOW()) RETURNING id::text AS id`,
    [`${seller}-opening`,seller,observation.rows[0]!.id,cutoff,`${seller}-apply`]);
  const runId=opening.rows[0]!.id as string;
  await pool.query(`INSERT INTO inventory_pending_mutations
    (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
    VALUES ($1,'opening',88001,2,3,7,11,2,2)`,[`${seller}-opening-88001`]);
  const openingReceipt=await pool.query(`INSERT INTO inventory_receipts
    (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,intake_at,market_value,
     market_provenance,receipt_kind,opening_balance_run_id,fifo_precedence)
    VALUES ($1,88001,2,3,7,11,$2,NULL,NULL,'opening_balance_unknown','opening_balance',$3,0) RETURNING receipt_id`,
    [`${seller}-opening-88001`,seller,runId]);
  const openingReceiptId=openingReceipt.rows[0]!.receipt_id as number;
  await pool.query(`INSERT INTO inventory_opening_balance_items (run_id,sku,opening_quantity,receipt_id)
    VALUES ($1,88001,2,$2)`,[runId,openingReceiptId]);

  const batch=await pool.query(`INSERT INTO inventory_batches (status,source_type,source_label)
    VALUES ('published','pending_inventory','Inventory Manager') RETURNING batch_number AS "batchNumber"`);
  const batchNumber=batch.rows[0]!.batchNumber as number;
  // 88001: opening 2, published 3, ordered 1 before the cutoff -> nothing unknown.
  const coveredItem=await addLegacyPublication(batchNumber,88001,3,5,null);
  // 88002: no opening units, published 1, ordered 2 -> one unknown-origin unit sold first.
  const unknownItem=await addLegacyPublication(batchNumber,88002,1,2.5,null);
  // 88003: published 2 but never ordered and not in the opening export -> cannot balance, stays legacy.
  const conflictItem=await addLegacyPublication(batchNumber,88003,2,4,seller);

  await addOrder("PRE","2026-08-09T12:00:00Z",1,"88001");
  await addOrder("A1","2026-08-11T12:00:00Z",1,"88001");
  await addOrder("A2","2026-09-09T00:00:00Z",1,"88001");
  await addOrder("B1","2026-08-12T12:00:00Z",2,"88002");
  while(await repo.processNextReplay(seller)){}
  assert.deepEqual((await repo.findOrderAllocation(seller,"A1")).map((line:any)=>[line.state,line.matchedQuantity]),[["excluded_pre_cutoff",0]]);
  assert.deepEqual((await repo.findOrderAllocation(seller,"A2")).map((line:any)=>[line.state,line.matchedQuantity,line.priceKnownQuantity]),[["allocated",1,0]]);

  await runMigration();
  const afterFirst=await counts();
  assert.deepEqual(afterFirst,{receipts:4,links:2,coverage:2,generations:2});
  await runMigration();
  assert.deepEqual(await counts(),afterFirst,"a second pass must not add evidence");

  const coverage=await pool.query(`SELECT sku,covered_from AS "coveredFrom",published_quantity AS published,
      ordered_quantity AS ordered,opening_quantity AS opening,unknown_quantity AS unknown,opening_receipt_id AS "openingReceiptId",
      evidence FROM inventory_listing_history_coverage WHERE seller_key=$1 ORDER BY sku`,[seller]);
  assert.deepEqual(coverage.rows.map((row)=>[row.sku,row.coveredFrom.toISOString(),row.published,row.ordered,row.opening,row.unknown]),
    [[88001,listedAt.toISOString(),3,1,2,0],[88002,listedAt.toISOString(),1,2,0,1]]);
  assert.equal(coverage.rows[0]!.openingReceiptId,openingReceiptId);
  assert.deepEqual(coverage.rows[0]!.evidence.publicationItemIds,[Number(coveredItem)]);
  const unknownReceipt=await pool.query(`SELECT receipt_kind AS kind,original_quantity AS quantity,market_provenance AS provenance,
      opening_balance_run_id::text AS "runId",fifo_precedence AS precedence,intake_at AS "intakeAt"
    FROM inventory_receipts WHERE receipt_id=$1`,[coverage.rows[1]!.openingReceiptId]);
  assert.deepEqual(unknownReceipt.rows[0],{kind:"opening_balance",quantity:1,provenance:"listing_history_unknown",runId,precedence:0,intakeAt:null});

  const historical=await pool.query(`SELECT receipt.request_id AS "requestId",receipt.sku,receipt.original_quantity AS quantity,
      receipt.seller_key AS "sellerKey",receipt.intake_at AS "intakeAt",receipt.market_value::float8 AS "marketValue",
      receipt.market_observed_at AS "marketObservedAt",receipt.market_calculated_at AS "marketCalculatedAt",
      receipt.market_provenance AS provenance,receipt.source_evidence AS evidence,receipt.receipt_kind AS kind,
      link.publication_item_id::text AS "itemId",link.planned_quantity AS planned,link.live_at AS "liveAt",
      link.target_seller_key AS "linkSeller",link.confirmation_evidence AS confirmation,
      (SELECT linked_quantity FROM inventory_receipt_batch_links batch WHERE batch.receipt_id=receipt.receipt_id) AS "batchLinked"
    FROM inventory_receipts receipt JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
    WHERE receipt.seller_key=$1 ORDER BY receipt.sku`,[seller]);
  assert.deepEqual(historical.rows.map((row)=>[row.requestId,row.sku,row.quantity,row.sellerKey,row.intakeAt.toISOString(),row.marketValue,
      row.marketObservedAt.toISOString(),row.marketCalculatedAt.toISOString(),row.provenance,row.kind,row.itemId,row.planned,
      row.liveAt.toISOString(),row.linkSeller,row.batchLinked,row.evidence.sellerAttribution,row.evidence.intakeBasis,row.confirmation.source]),
    [[`historical-publication:${coveredItem}`,88001,3,seller,listedAt.toISOString(),5,pricedAt.toISOString(),marketDataAt.toISOString(),
        "historical_pricing_result","received",coveredItem,3,listedAt.toISOString(),seller,3,"only_applied_opening_balance_seller",
        "publication_live_time","migration_045_historical_publication"],
      [`historical-publication:${unknownItem}`,88002,1,seller,listedAt.toISOString(),2.5,pricedAt.toISOString(),marketDataAt.toISOString(),
        "historical_pricing_result","received",unknownItem,1,listedAt.toISOString(),seller,1,"only_applied_opening_balance_seller",
        "publication_live_time","migration_045_historical_publication"]]);
  const conflictLinks=await pool.query(`SELECT COUNT(*)::int AS count FROM inventory_publication_receipt_links WHERE publication_item_id=$1`,[conflictItem]);
  assert.equal(conflictLinks.rows[0]!.count,0);
  await assert.rejects(pool.query(`UPDATE inventory_listing_history_coverage SET unknown_quantity=unknown_quantity WHERE seller_key=$1`,[seller]),
    /immutable/);

  const queue=await pool.query(`SELECT sku,affected_from AS "affectedFrom",status FROM inventory_fifo_replay_queue WHERE seller_key=$1 ORDER BY sku`,[seller]);
  assert.deepEqual(queue.rows.map((row)=>[row.sku,row.affectedFrom.toISOString(),row.status]),
    [[88001,listedAt.toISOString(),"pending"],[88002,listedAt.toISOString(),"pending"]]);
  while(await repo.processNextReplay(seller)){}
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM inventory_fifo_replay_queue WHERE seller_key=$1`,[seller])).rows[0]!.count,0);

  const summarize=(line:any)=>[line.state,line.matchedQuantity,line.priceKnownQuantity,line.intakeMarketTotal,line.dateKnownQuantity,
    line.weightedDaysHeld,[...line.allocations].sort((a:any,b:any)=>receiptNumber(a.supplyKey)-receiptNumber(b.supplyKey))
      .map((allocation:any)=>[allocation.supplyKey,allocation.quantity])];
  assert.deepEqual((await repo.findOrderAllocation(seller,"PRE")).map(summarize),[["excluded_pre_cutoff",0,0,null,0,null,[]]]);
  const coveredKey=`receipt:${(await pool.query(`SELECT receipt_id FROM inventory_receipts WHERE request_id=$1`,[`historical-publication:${coveredItem}`])).rows[0]!.receipt_id}`;
  const unknownKey=`receipt:${(await pool.query(`SELECT receipt_id FROM inventory_receipts WHERE request_id=$1`,[`historical-publication:${unknownItem}`])).rows[0]!.receipt_id}`;
  assert.deepEqual((await repo.findOrderAllocation(seller,"A1")).map(summarize),[["allocated",1,1,5,1,1,[[coveredKey,1]]]]);
  assert.deepEqual((await repo.findOrderAllocation(seller,"A2")).map(summarize),
    [["allocated",1,1,5,1,(Date.parse("2026-09-09T00:00:00Z")-listedAt.getTime())/dayMs,[[coveredKey,1]]]]);
  assert.deepEqual((await repo.findOrderAllocation(seller,"B1")).map(summarize),
    [["allocated",2,1,2.5,1,2,[[unknownKey,1],[`receipt:${coverage.rows[1]!.openingReceiptId}`,1]]]]);

  const report=await inventorySellingHistoryRepository.findEvidence(seller,DEFAULT_SELLING_HISTORY_SCOPE);
  assert.equal(report.openingUnknownQuantity,1);
  assert.deepEqual(report.legacyUnlinked,{quantity:2,forecastQuantity:0});
  assert.deepEqual([...report.episodes].sort((a,b)=>receiptNumber(a.episodeKey)-receiptNumber(b.episodeKey))
    .map((episode)=>[episode.episodeKey,episode.quantity,episode.listedAt]),
    [[coveredKey,3,listedAt.toISOString()],[unknownKey,1,listedAt.toISOString()]]);
  assert.deepEqual(report.outcomes.map((outcome)=>[outcome.episodeKey,outcome.kind,outcome.quantity,outcome.orderNumber]),
    [[coveredKey,"sale",1,"A1"],[unknownKey,"sale",1,"B1"],[coveredKey,"sale",1,"A2"]]);
  console.log("Listing history coverage integration test passed.");
}finally{
  await pool.end();
}