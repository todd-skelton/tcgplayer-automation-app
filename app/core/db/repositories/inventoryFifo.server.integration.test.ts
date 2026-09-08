import assert from "node:assert/strict";

const testUrl=process.env.TEST_DATABASE_URL;
if(!testUrl)throw new Error("TEST_DATABASE_URL is required before FIFO integration tests.");
const databaseName=new URL(testUrl).pathname.replace(/^\/+/,"");
if(!databaseName.startsWith("tcgplayer_fifo_test_"))throw new Error("FIFO integration tests require a tcgplayer_fifo_test_* database.");
if(process.env.DATABASE_URL!==testUrl)throw new Error("DATABASE_URL must exactly match TEST_DATABASE_URL.");

const {getPool}=await import("../database.server");
const {inventoryFifoRepository:repo}=await import("./inventoryFifo.server");
const {inventoryOpeningBalancesRepository:openingRepo}=await import("./inventoryOpeningBalances.server");
const {quantityFingerprint,supportedQuantityFingerprint}=await import("~/features/inventory-opening-balance/domain/inventoryObservation");
const pool=getPool();
const seller=`fifo-${Date.now()}`;
const cutoff=new Date("2026-09-07T12:00:00Z");

async function addOrder(number:string,time:string,quantity:number,sellerKey=seller,lifecycle="ready_to_ship"){
  const inserted=await pool.query(`INSERT INTO seller_orders
    (seller_key,order_number,order_time,lifecycle,provider_status,gross_item_proceeds,source_fingerprint,
     first_observed_at,last_observed_at,detail_observed_at,latest_source)
    VALUES ($1,$2,$3,$4,$4,1,'fp',NOW(),NOW(),NOW(),'tcgplayer_api') RETURNING id::text AS id`,
    [sellerKey,number,time,lifecycle]);
  const id=inserted.rows[0]!.id as string;
  await pool.query(`INSERT INTO seller_order_lines
    (order_id,sku_id,product_name,ordered_quantity,gross_item_proceeds) VALUES ($1,'99001','Synthetic', $2,1)`,[id,quantity]);
  await pool.query(`INSERT INTO seller_order_revisions
    (order_id,revision_number,source_fingerprint,source,observed_at,provider_status,lifecycle,line_evidence)
    VALUES ($1,1,'fp','tcgplayer_api',NOW(),$2,$2,'[]')`,[id,lifecycle]);
  await repo.enqueueOrderRevision(id);
  return id;
}

try{
  const observation=await pool.query(`INSERT INTO inventory_complete_observations
    (request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,quantity_fingerprint,
     supported_quantity_fingerprint,first_content_fingerprint,second_content_fingerprint,item_count,
     positive_item_count,total_quantity,supported_positive_sku_count,supported_total_quantity,
     unsupported_positive_item_count,unsupported_positive_quantity,identity_evidence)
    VALUES ($1,$2,'seller_portal_live_export','complete','sellable_excludes_reserved',$3,$3,'q','s','a','b',1,1,3,1,3,0,0,'{}')
    RETURNING id::text AS id`,[`${seller}-observation`,seller,cutoff]);
  const opening=await pool.query(`INSERT INTO inventory_opening_balance_runs
    (request_id,seller_key,observation_id,cutoff_at,status,evidence_fingerprint,apply_request_id,
     validation_observation_id,validation_order_coverage_evidence,applied_at)
    VALUES ($1,$2,$3,$4,'applied','opening-fp',$5,$3,'{}',NOW()) RETURNING id::text AS id`,
    [`${seller}-opening`,seller,observation.rows[0]!.id,cutoff,`${seller}-apply`]);
  await pool.query(`INSERT INTO inventory_complete_observation_items
    (observation_id,inventory_key,identity_kind,sku,quantity) VALUES ($1,'99001','standard_sku',99001,3)`,
    [observation.rows[0]!.id]);
  await pool.query(`INSERT INTO inventory_pending_mutations
    (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
    VALUES ($1,'opening',99001,3,1,1,1,3,3)`,[`${seller}-opening-mutation`]);
  const receipt=await pool.query(`INSERT INTO inventory_receipts
    (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,intake_at,market_value,
     market_provenance,receipt_kind,opening_balance_run_id,fifo_precedence)
    VALUES ($1,99001,3,1,1,1,$2,NULL,NULL,'unavailable','opening_balance',$3,0) RETURNING receipt_id`,
    [`${seller}-opening-mutation`,seller,opening.rows[0]!.id]);
  await pool.query(`INSERT INTO inventory_opening_balance_items (run_id,sku,opening_quantity,receipt_id)
    VALUES ($1,99001,3,$2)`,[opening.rows[0]!.id,receipt.rows[0]!.receipt_id]);

  await addOrder("PRE","2026-09-07T11:59:59Z",1);
  const firstOrder=await addOrder("A","2026-09-07T12:00:00Z",2);
  await addOrder("B","2026-09-07T12:01:00Z",2);
  await addOrder("C","2026-09-07T12:05:00Z",1);
  const otherOrder=await addOrder("OTHER","2026-09-07T12:01:00Z",1,`${seller}-other`);
  while(await repo.processNextReplay()){}
  assert.deepEqual((await repo.findOrderAllocation(seller,"PRE")).map((line:any)=>[line.state,line.matchedQuantity]),[["excluded_pre_cutoff",0]]);
  assert.deepEqual((await repo.findOrderAllocation(seller,"A")).map((line:any)=>[line.state,line.matchedQuantity]),[["allocated",2]]);
  assert.deepEqual((await repo.findOrderAllocation(seller,"B")).map((line:any)=>[line.state,line.matchedQuantity,line.unmatchedQuantity]),[["partial",1,1]]);
  assert.equal((await repo.findOrderAllocation(seller,"C"))[0]?.unmatchedQuantity,1);
  assert.equal((await repo.findOrderAllocation(seller,"OTHER")).length,0);
  assert.deepEqual((await repo.findOrderAllocation(`${seller}-other`,"OTHER")).map((line:any)=>
    [line.state,line.allocationPending]),[["pending",true]]);

  await repo.recordDisposition({requestId:`${seller}-restock`,sellerKey:seller,orderNumber:"A",skuId:"99001",
    dispositionType:"physical_restock",quantity:1,sourceOrderRevision:1,availableAt:new Date("2026-09-07T12:02:00Z"),
    evidence:{kind:"physical_return",reference:"synthetic"},sourceAllocations:[{supplyKey:`receipt:${receipt.rows[0]!.receipt_id}`,receiptId:receipt.rows[0]!.receipt_id,quantity:1}]});
  await repo.processNextReplay();
  assert.deepEqual((await repo.findOrderAllocation(seller,"B")).map((line:any)=>[line.state,line.matchedQuantity,line.unmatchedQuantity]),[["partial",1,1]]);
  assert.equal((await repo.findOrderAllocation(seller,"C"))[0]?.unmatchedQuantity,0);
  const revisionCount=await pool.query(`SELECT COUNT(*)::int AS count FROM inventory_fifo_revisions`);
  assert.equal(await repo.processNextReplay(),null);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM inventory_fifo_revisions`)).rows[0]!.count,revisionCount.rows[0]!.count);

  await pool.query(`UPDATE seller_order_lines SET ordered_quantity=1 WHERE order_id=$1`,[firstOrder]);
  await pool.query(`UPDATE seller_orders SET source_revision=2 WHERE id=$1`,[firstOrder]);
  await repo.enqueueOrderRevision(firstOrder);
  const held=await repo.processNextReplay();
  assert.equal(held?.status,"held");
  assert.match((held as any).reason,/quantity_reduction_after_restock/);
  const holdList=await repo.listHolds(seller);
  assert.equal(holdList.queue.length,1);

  await repo.supersedeDisposition({requestId:`${seller}-correction`,sellerKey:seller,dispositionId:(await pool.query(
    `SELECT id::text AS id FROM inventory_stock_dispositions WHERE request_id=$1`,[`${seller}-restock`])).rows[0]!.id,
    sourceOrderRevision:2,confirmedAt:new Date("2026-09-07T12:04:00Z"),evidence:{kind:"provider_quantity_correction"}});
  await repo.processNextReplay();
  assert.equal((await repo.listHolds(seller)).queue.length,0);
  assert.equal((await repo.findOrderAllocation(seller,"B"))[0]?.unmatchedQuantity,1);
  assert.equal((await repo.findOrderAllocation(seller,"C"))[0]?.unmatchedQuantity,0);
  const differenceItems=[{inventoryKey:"99001",identityKind:"standard_sku" as const,sku:99001,quantity:2,
    productLine:"",setName:"",productName:"",condition:"",variant:""}];
  const differenceClaim=await openingRepo.beginObservationCapture({requestId:`${seller}-difference`,sellerKey:seller});
  if(differenceClaim.state!=="claimed")throw new Error("Expected inventory difference claim.");
  const difference=await openingRepo.recordObservation({requestId:`${seller}-difference`,sellerKey:seller,
    claimToken:differenceClaim.claimToken,status:"complete",startedAt:new Date("2026-09-08T00:00:00Z"),
    cutoffAt:new Date("2026-09-08T00:00:01Z"),quantityFingerprint:quantityFingerprint(differenceItems),
    supportedQuantityFingerprint:supportedQuantityFingerprint(differenceItems),firstContentFingerprint:"difference-a",
    secondContentFingerprint:"difference-b",beforeIdentityDeclarationCount:2,afterIdentityDeclarationCount:2,items:differenceItems});
  const differenceReplay=await repo.processNextReplay(seller);
  assert.equal(differenceReplay?.status,"held");
  assert.match((differenceReplay as any).reason,/unexplained_inventory_difference/);
  const differenceId=(await pool.query(`SELECT id::text AS id FROM inventory_observation_differences
    WHERE observation_id=$1 AND sku=99001`,[difference.id])).rows[0]!.id;
  await openingRepo.acknowledgeDifference({requestId:`${seller}-ack`,id:differenceId,sellerKey:seller,note:"Reviewed; no stock disposition."});
  assert.equal((await repo.listHolds(seller)).queue[0]?.status,"held");
  assert.ok(otherOrder);
  console.log("PASS FIFO repository conserves opening supply, dates restocks, isolates sellers, replays once, and holds ambiguous reductions");
}finally{await pool.end();}

