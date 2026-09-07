import { createHash, randomUUID } from "node:crypto";
import { allocateInventoryFifo, type FifoLineResult, type FifoOrderLine, type FifoSupplyLot } from "~/features/inventory-fifo/domain/allocateInventoryFifo";
import { asJson, execute, query, queryOne, withTransaction, type Queryable } from "../database.server";

const supportedLifecycles=new Set(["processing","ready_to_ship","shipped_in_transit","shipped_delivered","completed_paid"]);

function canonicalEvidence(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonicalEvidence).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([key,item])=>`${JSON.stringify(key)}:${canonicalEvidence(item)}`).join(",")}}`;
  return JSON.stringify(value)??"null";
}

export function standardInventorySku(value:string):number|null{
  if(!/^\d+$/.test(value))return null;
  const sku=Number(value);
  return Number.isInteger(sku)&&sku>0&&sku<=2_147_483_647?sku:null;
}

async function enqueue(sellerKey:string,sku:number,affectedFrom:Date,db:Queryable){
  await execute(`INSERT INTO inventory_fifo_replay_queue
      (seller_key,sku,affected_from,status,generation)
    VALUES ($1,$2,$3,'pending',1)
    ON CONFLICT (seller_key,sku) DO UPDATE SET
      affected_from=LEAST(inventory_fifo_replay_queue.affected_from,EXCLUDED.affected_from),
      generation=inventory_fifo_replay_queue.generation+1,status='pending',
      claim_token=NULL,claim_expires_at=NULL,hold_reason=NULL,updated_at=NOW()`,
    [sellerKey,sku,affectedFrom],db);
}

type SavedLine={
  sellerKey:string;orderId:string;skuId:string;sku:number|null;orderTime:Date;orderedQuantity:number;
  sourceOrderRevision:number;state:string;holdReason:string|null;matchedQuantity:number;unmatchedQuantity:number;
  priceKnownQuantity:number;dateKnownQuantity:number;intakeMarketTotal:string|null;weightedDaysHeld:string|null;
  allocations:Array<{supplyKey:string;receiptId:number;dispositionId:string|null;quantity:number;availableAt:string}>;
};

function lineFingerprint(value:SavedLine){
  return createHash("sha256").update(JSON.stringify({
    sourceOrderRevision:value.sourceOrderRevision,orderTime:value.orderTime.toISOString(),
    orderedQuantity:value.orderedQuantity,state:value.state,holdReason:value.holdReason,
    matchedQuantity:value.matchedQuantity,unmatchedQuantity:value.unmatchedQuantity,
    priceKnownQuantity:value.priceKnownQuantity,dateKnownQuantity:value.dateKnownQuantity,
    intakeMarketTotal:value.intakeMarketTotal,weightedDaysHeld:value.weightedDaysHeld,
    allocations:value.allocations.map((allocation)=>[allocation.supplyKey,allocation.receiptId,allocation.dispositionId,allocation.quantity,allocation.availableAt]),
  })).digest("hex");
}

async function saveLine(value:SavedLine,triggerReason:string,db:Queryable){
  const fingerprint=lineFingerprint(value);
  let line=await queryOne<{id:string;revisionNumber:number;fingerprint:string|null}>(
    `SELECT line.id::text AS id,COALESCE(revision.revision_number,0)::int AS "revisionNumber",
      revision.source_fingerprint AS fingerprint
     FROM inventory_fifo_lines line
     LEFT JOIN inventory_fifo_revisions revision ON revision.id=line.current_revision_id
     WHERE line.order_id=$1 AND line.order_line_sku_id=$2 FOR UPDATE OF line`,[value.orderId,value.skuId],db);
  if(line?.fingerprint===fingerprint)return {changed:false,lineId:line.id,revision:line.revisionNumber};
  if(!line){
    line=await queryOne<{id:string;revisionNumber:number;fingerprint:null}>(`INSERT INTO inventory_fifo_lines
      (seller_key,order_id,order_line_sku_id,sku,order_time,ordered_quantity,source_order_revision,state,hold_reason,
       matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity,intake_market_total,weighted_days_held)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id::text AS id,0 AS "revisionNumber",NULL AS fingerprint`,
      [value.sellerKey,value.orderId,value.skuId,value.sku,value.orderTime,value.orderedQuantity,value.sourceOrderRevision,
        value.state,value.holdReason,value.matchedQuantity,value.unmatchedQuantity,value.priceKnownQuantity,
        value.dateKnownQuantity,value.intakeMarketTotal,value.weightedDaysHeld],db);
    if(!line)throw new Error("Failed to create FIFO line.");
  }
  const revisionNumber=line.revisionNumber+1;
  const revision=await queryOne<{id:string}>(`INSERT INTO inventory_fifo_revisions
    (line_id,revision_number,source_order_revision,order_time,trigger_reason,state,hold_reason,ordered_quantity,
     matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity,intake_market_total,
     weighted_days_held,source_fingerprint)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id::text AS id`,
    [line.id,revisionNumber,value.sourceOrderRevision,value.orderTime,triggerReason,value.state,value.holdReason,value.orderedQuantity,
      value.matchedQuantity,value.unmatchedQuantity,value.priceKnownQuantity,value.dateKnownQuantity,
      value.intakeMarketTotal,value.weightedDaysHeld,fingerprint],db);
  if(!revision)throw new Error("Failed to create FIFO revision.");
  if(value.allocations.length)await execute(`INSERT INTO inventory_fifo_revision_allocations
      (revision_id,supply_key,receipt_id,disposition_id,allocated_quantity,available_at)
    SELECT $1,x."supplyKey",x."receiptId",x."dispositionId"::bigint,x.quantity,x."availableAt"::timestamptz
    FROM jsonb_to_recordset($2::jsonb) AS x(
      "supplyKey" text,"receiptId" integer,"dispositionId" text,quantity integer,"availableAt" text)`,
    [revision.id,asJson(value.allocations)],db);
  await execute(`UPDATE inventory_fifo_lines SET sku=$2,order_time=$3,ordered_quantity=$4,source_order_revision=$5,
      state=$6,hold_reason=$7,matched_quantity=$8,unmatched_quantity=$9,price_known_quantity=$10,
      date_known_quantity=$11,intake_market_total=$12,weighted_days_held=$13,current_revision_id=$14,updated_at=NOW()
    WHERE id=$1`,[line.id,value.sku,value.orderTime,value.orderedQuantity,value.sourceOrderRevision,value.state,
      value.holdReason,value.matchedQuantity,value.unmatchedQuantity,value.priceKnownQuantity,value.dateKnownQuantity,
      value.intakeMarketTotal,value.weightedDaysHeld,revision.id],db);
  return {changed:true,lineId:line.id,revision:revisionNumber};
}

async function saveLines(values:SavedLine[],triggerReason:string,db:Queryable){
  if(!values.length)return 0;
  const prepared=values.map((value)=>({...value,orderTime:value.orderTime.toISOString(),fingerprint:lineFingerprint(value)}));
  await execute(`INSERT INTO inventory_fifo_lines
      (seller_key,order_id,order_line_sku_id,sku,order_time,ordered_quantity,source_order_revision,state,hold_reason,
       matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity,intake_market_total,weighted_days_held)
    SELECT x."sellerKey",x."orderId"::bigint,x."skuId",x.sku,x."orderTime"::timestamptz,x."orderedQuantity",
      x."sourceOrderRevision",x.state,x."holdReason",x."matchedQuantity",x."unmatchedQuantity",
      x."priceKnownQuantity",x."dateKnownQuantity",x."intakeMarketTotal"::numeric,x."weightedDaysHeld"::numeric
    FROM jsonb_to_recordset($1::jsonb) AS x("sellerKey" text,"orderId" text,"skuId" text,sku integer,
      "orderTime" text,"orderedQuantity" integer,"sourceOrderRevision" integer,state text,"holdReason" text,
      "matchedQuantity" integer,"unmatchedQuantity" integer,"priceKnownQuantity" integer,"dateKnownQuantity" integer,
      "intakeMarketTotal" text,"weightedDaysHeld" text)
    ON CONFLICT (order_id,order_line_sku_id) DO NOTHING`,[asJson(prepared)],db);
  const current=await query<{lineId:string;orderId:string;skuId:string;revisionNumber:number;fingerprint:string|null}>(`SELECT line.id::text AS "lineId",
      line.order_id::text AS "orderId",line.order_line_sku_id AS "skuId",COALESCE(revision.revision_number,0)::int AS "revisionNumber",
      revision.source_fingerprint AS fingerprint
    FROM inventory_fifo_lines line LEFT JOIN inventory_fifo_revisions revision ON revision.id=line.current_revision_id
    JOIN jsonb_to_recordset($1::jsonb) AS x("orderId" text,"skuId" text)
      ON line.order_id=x."orderId"::bigint AND line.order_line_sku_id=x."skuId"
    FOR UPDATE OF line`,[asJson(prepared)],db);
  const currentByIdentity=new Map(current.map((row)=>[`${row.orderId}:${row.skuId}`,row]));
  const changed=prepared.map((value)=>{
    const row=currentByIdentity.get(`${value.orderId}:${value.skuId}`);
    if(!row)throw new Error("Failed to materialize FIFO line.");
    return {...value,lineId:row.lineId,revisionNumber:row.revisionNumber+1};
  }).filter((value)=>currentByIdentity.get(`${value.orderId}:${value.skuId}`)?.fingerprint!==value.fingerprint);
  if(!changed.length)return 0;
  const revisions=await query<{id:string;lineId:string}>(`INSERT INTO inventory_fifo_revisions
      (line_id,revision_number,source_order_revision,order_time,trigger_reason,state,hold_reason,ordered_quantity,
       matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity,intake_market_total,
       weighted_days_held,source_fingerprint)
    SELECT x."lineId"::bigint,x."revisionNumber",x."sourceOrderRevision",x."orderTime"::timestamptz,$2,x.state,
      x."holdReason",x."orderedQuantity",x."matchedQuantity",x."unmatchedQuantity",x."priceKnownQuantity",
      x."dateKnownQuantity",x."intakeMarketTotal"::numeric,x."weightedDaysHeld"::numeric,x.fingerprint
    FROM jsonb_to_recordset($1::jsonb) AS x("lineId" text,"revisionNumber" integer,"sourceOrderRevision" integer,
      "orderTime" text,state text,"holdReason" text,"orderedQuantity" integer,"matchedQuantity" integer,
      "unmatchedQuantity" integer,"priceKnownQuantity" integer,"dateKnownQuantity" integer,
      "intakeMarketTotal" text,"weightedDaysHeld" text,fingerprint text)
    RETURNING id::text AS id,line_id::text AS "lineId"`,[asJson(changed),triggerReason],db);
  const revisionByLine=new Map(revisions.map((row)=>[row.lineId,row.id]));
  const allocations=changed.flatMap((value)=>value.allocations.map((allocation)=>({
    ...allocation,revisionId:revisionByLine.get(value.lineId),
  })));
  if(allocations.length)await execute(`INSERT INTO inventory_fifo_revision_allocations
      (revision_id,supply_key,receipt_id,disposition_id,allocated_quantity,available_at)
    SELECT x."revisionId"::bigint,x."supplyKey",x."receiptId",x."dispositionId"::bigint,x.quantity,x."availableAt"::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS x("revisionId" text,"supplyKey" text,"receiptId" integer,
      "dispositionId" text,quantity integer,"availableAt" text)`,[asJson(allocations)],db);
  await execute(`UPDATE inventory_fifo_lines line SET sku=x.sku,order_time=x."orderTime"::timestamptz,
      ordered_quantity=x."orderedQuantity",source_order_revision=x."sourceOrderRevision",state=x.state,
      hold_reason=x."holdReason",matched_quantity=x."matchedQuantity",unmatched_quantity=x."unmatchedQuantity",
      price_known_quantity=x."priceKnownQuantity",date_known_quantity=x."dateKnownQuantity",
      intake_market_total=x."intakeMarketTotal"::numeric,weighted_days_held=x."weightedDaysHeld"::numeric,
      current_revision_id=x."revisionId"::bigint,updated_at=NOW()
    FROM jsonb_to_recordset($1::jsonb) AS x("lineId" text,sku integer,"orderTime" text,"orderedQuantity" integer,
      "sourceOrderRevision" integer,state text,"holdReason" text,"matchedQuantity" integer,"unmatchedQuantity" integer,
      "priceKnownQuantity" integer,"dateKnownQuantity" integer,"intakeMarketTotal" text,"weightedDaysHeld" text,"revisionId" text)
    WHERE line.id=x."lineId"::bigint`,[asJson(changed.map((value)=>({...value,revisionId:revisionByLine.get(value.lineId)})))],db);
  return changed.length;
}

async function holdQueue(sellerKey:string,sku:number,reason:string,db:Queryable){
  await execute(`UPDATE inventory_fifo_replay_queue SET status='held',claim_token=NULL,claim_expires_at=NULL,
    hold_reason=$3,updated_at=NOW() WHERE seller_key=$1 AND sku=$2`,[sellerKey,sku,reason],db);
  return {status:"held" as const,sellerKey,sku,reason};
}

export const inventoryFifoRepository={
  async enqueueOrderRevision(orderId:string,executor?:Queryable){
    const perform=async(db:Queryable)=>{
      const order=await queryOne<{sellerKey:string;orderTime:Date;sourceRevision:number}>(`SELECT seller_key AS "sellerKey",
        order_time AS "orderTime",source_revision AS "sourceRevision" FROM seller_orders WHERE id=$1`,[orderId],db);
      if(!order)throw new Error("Seller order was not found for FIFO.");
      const current=await query<{skuId:string;quantity:number}>(`SELECT sku_id AS "skuId",ordered_quantity AS quantity
        FROM seller_order_lines WHERE order_id=$1`,[orderId],db);
      const existing=await query<{skuId:string;sku:number|null}>(`SELECT order_line_sku_id AS "skuId",sku
        FROM inventory_fifo_lines WHERE order_id=$1`,[orderId],db);
      const numeric=new Map<number,string>();
      for(const line of [...current,...existing]){
        const sku="sku" in line&&line.sku!==null?line.sku:standardInventorySku(line.skuId);
        if(sku!==null)numeric.set(sku,line.skuId);
      }
      for(const sku of [...numeric.keys()].sort((a,b)=>a-b))await enqueue(order.sellerKey,sku,order.orderTime,db);
      for(const line of current.filter((value)=>standardInventorySku(value.skuId)===null)){
        await saveLine({sellerKey:order.sellerKey,orderId,skuId:line.skuId,sku:null,orderTime:order.orderTime,
          orderedQuantity:line.quantity,sourceOrderRevision:order.sourceRevision,state:"unsupported",
          holdReason:"unsupported_inventory_identity",matchedQuantity:0,unmatchedQuantity:line.quantity,
          priceKnownQuantity:0,dateKnownQuantity:0,intakeMarketTotal:null,weightedDaysHeld:null,allocations:[]},
        "order_revision",db);
      }
      for(const line of existing.filter((value)=>value.sku===null&&!current.some((currentLine)=>currentLine.skuId===value.skuId))){
        await saveLine({sellerKey:order.sellerKey,orderId,skuId:line.skuId,sku:null,orderTime:order.orderTime,
          orderedQuantity:0,sourceOrderRevision:order.sourceRevision,state:"removed",holdReason:null,
          matchedQuantity:0,unmatchedQuantity:0,priceKnownQuantity:0,dateKnownQuantity:0,
          intakeMarketTotal:null,weightedDaysHeld:null,allocations:[]},"order_line_removed",db);
      }
    };
    return executor?perform(executor):withTransaction(perform);
  },

  async enqueueSellerSku(sellerKey:string,sku:number,affectedFrom:Date,executor?:Queryable){
    const perform=(db:Queryable)=>enqueue(sellerKey.trim(),sku,affectedFrom,db);
    return executor?perform(executor):withTransaction(perform);
  },

  async enqueueSellerSkus(sellerKey:string,values:Array<{sku:number;affectedFrom:Date}>,executor?:Queryable){
    if(!values.length)return;
    const perform=(db:Queryable)=>execute(`INSERT INTO inventory_fifo_replay_queue
        (seller_key,sku,affected_from,status,generation)
      SELECT $1,x.sku,x."affectedFrom"::timestamptz,'pending',1
      FROM jsonb_to_recordset($2::jsonb) AS x(sku integer,"affectedFrom" text)
      ON CONFLICT (seller_key,sku) DO UPDATE SET
        affected_from=LEAST(inventory_fifo_replay_queue.affected_from,EXCLUDED.affected_from),
        generation=inventory_fifo_replay_queue.generation+1,status='pending',
        claim_token=NULL,claim_expires_at=NULL,hold_reason=NULL,updated_at=NOW()`,
      [sellerKey.trim(),asJson(values.map((value)=>({sku:value.sku,affectedFrom:value.affectedFrom.toISOString()})))],db);
    return executor?perform(executor):withTransaction(perform);
  },

  async processNextReplay(){
    return withTransaction(async(db)=>{
      const queued=await queryOne<{sellerKey:string;sku:number;affectedFrom:Date}>(`SELECT seller_key AS "sellerKey",sku,
        affected_from AS "affectedFrom" FROM inventory_fifo_replay_queue
        WHERE status='pending' OR (status='processing' AND claim_expires_at<NOW())
        ORDER BY updated_at,seller_key,sku FOR UPDATE SKIP LOCKED LIMIT 1`,[],db);
      if(!queued)return null;
      await execute(`UPDATE inventory_fifo_replay_queue SET status='processing',claim_token=$3,
        claim_expires_at=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE seller_key=$1 AND sku=$2`,
        [queued.sellerKey,queued.sku,randomUUID()],db);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`fifo:${queued.sellerKey}:${queued.sku}`]);
      const opening=await queryOne<{cutoffAt:Date}>(`SELECT cutoff_at AS "cutoffAt" FROM inventory_opening_balance_runs
        WHERE seller_key=$1 AND status='applied'`,[queued.sellerKey],db);
      if(!opening)return holdQueue(queued.sellerKey,queued.sku,"missing_applied_opening_balance",db);
      const externalDifferences=await query<{id:string;observedDelta:number;expectedDelta:number}>(`SELECT difference.id::text AS id,
        difference.quantity_delta AS "observedDelta",
        (
          COALESCE((SELECT SUM(link.planned_quantity)::int
            FROM inventory_publication_receipt_links link
            JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
            WHERE link.target_seller_key=difference.seller_key AND receipt.sku=difference.sku
              AND receipt.receipt_kind='received' AND link.live_at>=previous.cutoff_at
              AND link.live_at<observation.cutoff_at),0)
          + COALESCE((SELECT SUM(disposition.quantity)::int FROM inventory_stock_dispositions disposition
            WHERE disposition.seller_key=difference.seller_key AND disposition.sku=difference.sku
              AND disposition.available_at>=previous.cutoff_at AND disposition.available_at<observation.cutoff_at
              AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction
                WHERE correction.disposition_id=disposition.id)),0)
          - COALESCE((SELECT SUM(line.ordered_quantity)::int
            FROM seller_orders orders JOIN seller_order_lines line ON line.order_id=orders.id
            WHERE orders.seller_key=difference.seller_key
              AND orders.order_time>=previous.cutoff_at AND orders.order_time<observation.cutoff_at
              AND line.sku_id~'^[0-9]+$' AND length(line.sku_id)<=10
              AND line.sku_id::bigint=difference.sku),0)
        )::int AS "expectedDelta"
        FROM inventory_observation_differences difference
        JOIN inventory_complete_observations observation ON observation.id=difference.observation_id
        JOIN inventory_complete_observations previous ON previous.id=difference.previous_observation_id
        WHERE difference.seller_key=$1 AND difference.sku=$2 AND observation.cutoff_at>$3
        ORDER BY observation.cutoff_at,difference.id`,
        [queued.sellerKey,queued.sku,opening.cutoffAt],db);
      const unexplainedDifference=externalDifferences.find((difference)=>difference.observedDelta!==difference.expectedDelta);
      if(unexplainedDifference)return holdQueue(queued.sellerKey,queued.sku,
        `unexplained_inventory_difference:${unexplainedDifference.id}:observed_${unexplainedDifference.observedDelta}:expected_${unexplainedDifference.expectedDelta}`,db);
      const reductionConflict=await queryOne<{lineId:string}>(`SELECT line.id::text AS "lineId"
        FROM inventory_fifo_lines line
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=line.order_id
          AND current_line.sku_id=line.order_line_sku_id
        WHERE line.seller_key=$1 AND line.sku=$2
          AND COALESCE(current_line.ordered_quantity,0)<line.ordered_quantity
          AND EXISTS (
            SELECT 1 FROM inventory_stock_dispositions disposition
            WHERE disposition.order_id=line.order_id AND disposition.order_line_sku_id=line.order_line_sku_id
              AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction
                WHERE correction.disposition_id=disposition.id)
          ) LIMIT 1`,[queued.sellerKey,queued.sku],db);
      if(reductionConflict)return holdQueue(queued.sellerKey,queued.sku,`quantity_reduction_after_restock:${reductionConflict.lineId}`,db);

      const current=await query<any>(`SELECT orders.id::text AS "orderId",orders.order_number AS "orderNumber",
        orders.order_time AS "orderTime",orders.lifecycle,orders.source_revision AS "sourceRevision",
        line.sku_id AS "skuId",line.ordered_quantity AS quantity
        FROM seller_orders orders JOIN seller_order_lines line ON line.order_id=orders.id
        WHERE orders.seller_key=$1 AND line.sku_id~'^[0-9]+$' AND length(line.sku_id)<=10
          AND line.sku_id::bigint=$2`,[queued.sellerKey,queued.sku],db);
      const removed=await query<any>(`SELECT line.order_id::text AS "orderId",orders.order_number AS "orderNumber",
        orders.order_time AS "orderTime",orders.lifecycle,orders.source_revision AS "sourceRevision",
        line.order_line_sku_id AS "skuId",0::int AS quantity
        FROM inventory_fifo_lines line JOIN seller_orders orders ON orders.id=line.order_id
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=line.order_id
          AND current_line.sku_id=line.order_line_sku_id
        WHERE line.seller_key=$1 AND line.sku=$2 AND current_line.order_id IS NULL`,[queued.sellerKey,queued.sku],db);
      const demand=[...current,...removed];
      const lots=await query<any>(`SELECT 'receipt:'||receipt.receipt_id::text AS "supplyKey",
          receipt.receipt_id AS "receiptId",NULL::text AS "dispositionId",receipt.original_quantity AS quantity,
          opening.cutoff_at AS "availableAt",receipt.fifo_precedence AS "fifoPrecedence",
          receipt.intake_at AS "intakeAt",receipt.market_value::text AS "marketValue"
        FROM inventory_receipts receipt JOIN inventory_opening_balance_runs opening
          ON opening.id=receipt.opening_balance_run_id AND opening.status='applied'
        WHERE receipt.seller_key=$1 AND receipt.sku=$2 AND receipt.receipt_kind='opening_balance'
        UNION ALL
        SELECT 'receipt:'||receipt.receipt_id::text,receipt.receipt_id,NULL::text,link.planned_quantity,
          link.live_at,receipt.fifo_precedence,receipt.intake_at,receipt.market_value::text
        FROM inventory_receipts receipt JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
        WHERE receipt.seller_key=$1 AND link.target_seller_key=$1 AND receipt.sku=$2
          AND receipt.receipt_kind='received' AND link.live_at IS NOT NULL AND link.live_at>=$3
        UNION ALL
        SELECT 'restock:'||disposition.id::text||':'||mapping.receipt_id::text,mapping.receipt_id,
          disposition.id::text,mapping.quantity,disposition.available_at,receipt.fifo_precedence,
          receipt.intake_at,receipt.market_value::text
        FROM inventory_stock_dispositions disposition
        JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2
          AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction
            WHERE correction.disposition_id=disposition.id)`,[queued.sellerKey,queued.sku,opening.cutoffAt],db);
      const supplies:FifoSupplyLot[]=lots.map((row)=>({
        supplyKey:row.supplyKey,receiptId:row.receiptId,dispositionId:row.dispositionId,
        quantity:row.quantity,availableAt:(row.availableAt as Date).toISOString(),fifoPrecedence:row.fifoPrecedence,
        intakeAt:row.intakeAt?(row.intakeAt as Date).toISOString():null,
        marketValueTenThousandths:row.marketValue===null?null:Math.round(Number(row.marketValue)*10_000),
      }));
      const allocatable:FifoOrderLine[]=demand.filter((row)=>row.quantity>0&&row.orderTime>=opening.cutoffAt).map((row)=>({
        lineKey:`${row.orderId}:${row.skuId}`,orderId:row.orderId,orderNumber:row.orderNumber,
        orderTime:(row.orderTime as Date).toISOString(),quantity:row.quantity,
      }));
      const results=new Map(allocateInventoryFifo(allocatable,supplies).map((result)=>[result.lineKey,result]));
      const shipped=await query<{orderId:string}>(`SELECT DISTINCT revision.order_id::text AS "orderId"
        FROM seller_order_revisions revision JOIN seller_orders orders ON orders.id=revision.order_id
        JOIN seller_order_lines line ON line.order_id=orders.id
        WHERE orders.seller_key=$1 AND line.sku_id~'^[0-9]+$' AND length(line.sku_id)<=10
          AND line.sku_id::bigint=$2 AND revision.lifecycle IN ('shipped_in_transit','shipped_delivered')`,
        [queued.sellerKey,queued.sku],db);
      const shippedOrders=new Set(shipped.map((row)=>row.orderId));
      const dispositionRows=await query<any>(`SELECT disposition.id::text AS id,disposition.order_id::text AS "orderId",
        disposition.order_line_sku_id AS "skuId",disposition.disposition_type AS type,mapping.receipt_id AS "receiptId",
        mapping.quantity FROM inventory_stock_dispositions disposition
        JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2
          AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction
            WHERE correction.disposition_id=disposition.id)`,[queued.sellerKey,queued.sku],db);
      const dispositionsByLine=new Map<string,typeof dispositionRows>();
      const disposedByLineReceipt=new Map<string,number>();
      for(const disposition of dispositionRows){
        const lineKey=`${disposition.orderId}:${disposition.skuId}`;
        dispositionsByLine.set(lineKey,[...(dispositionsByLine.get(lineKey)??[]),disposition]);
        const receiptKey=`${lineKey}:${disposition.receiptId}`;
        disposedByLineReceipt.set(receiptKey,(disposedByLineReceipt.get(receiptKey)??0)+disposition.quantity);
      }
      for(const disposition of dispositionRows){
        const result=results.get(`${disposition.orderId}:${disposition.skuId}`);
        const allocated=result?.allocations.filter((allocation)=>allocation.receiptId===disposition.receiptId)
          .reduce((sum,allocation)=>sum+allocation.quantity,0)??0;
        const disposed=disposedByLineReceipt.get(`${disposition.orderId}:${disposition.skuId}:${disposition.receiptId}`)??0;
        if(disposed>allocated)return holdQueue(queued.sellerKey,queued.sku,`restock_lineage_conflict:${disposition.id}`,db);
      }
      const replayLines:SavedLine[]=[];
      for(const row of demand){
        const key=`${row.orderId}:${row.skuId}`;
        let result:FifoLineResult=results.get(key)??{lineKey:key,allocations:[],requestedQuantity:row.quantity,
          matchedQuantity:0,unmatchedQuantity:row.quantity,priceKnownQuantity:0,intakeMarketTotalCents:null,
          dateKnownQuantity:0,weightedDaysHeld:null};
        let state=result.matchedQuantity===row.quantity?"allocated":result.matchedQuantity?"partial":"unmatched";
        let holdReason:string|null=null;
        if(row.quantity===0){state="removed";result={...result,unmatchedQuantity:0};}
        else if(row.orderTime<opening.cutoffAt){state="excluded_pre_cutoff";result={...result,matchedQuantity:0,unmatchedQuantity:row.quantity,allocations:[],priceKnownQuantity:0,intakeMarketTotalCents:null,dateKnownQuantity:0,weightedDaysHeld:null};}
        else if(row.lifecycle==="canceled"){
          const lineDispositions=dispositionsByLine.get(key)??[];
          const restored=lineDispositions.reduce((sum,value)=>sum+value.quantity,0);
          const restorationProven=restored>=row.quantity&&lineDispositions.every((value)=>
            value.type==="physical_restock"||(value.type==="unfulfilled_cancellation"&&!shippedOrders.has(row.orderId)));
          if(!restorationProven){
            state="held";holdReason=shippedOrders.has(row.orderId)?"canceled_after_shipping_requires_restock":"cancellation_requires_disposition";
          }
        }else if(!supportedLifecycles.has(row.lifecycle)){state="held";holdReason="unknown_order_lifecycle";}
        replayLines.push({sellerKey:queued.sellerKey,orderId:row.orderId,skuId:row.skuId,sku:queued.sku,
          orderTime:row.orderTime,orderedQuantity:row.quantity,sourceOrderRevision:row.sourceRevision,state,holdReason,
          matchedQuantity:result.matchedQuantity,unmatchedQuantity:result.unmatchedQuantity,
          priceKnownQuantity:result.priceKnownQuantity,dateKnownQuantity:result.dateKnownQuantity,
          intakeMarketTotal:result.intakeMarketTotalCents===null?null:(result.intakeMarketTotalCents/100).toFixed(2),
          weightedDaysHeld:result.weightedDaysHeld===null?null:result.weightedDaysHeld.toFixed(6),
          allocations:result.allocations});
      }
      const changedLines=await saveLines(replayLines,"seller_sku_replay",db);
      await execute(`DELETE FROM inventory_fifo_replay_queue WHERE seller_key=$1 AND sku=$2`,[queued.sellerKey,queued.sku],db);
      return {status:"complete" as const,sellerKey:queued.sellerKey,sku:queued.sku,changedLines};
    });
  },

  async recordDisposition(input:{requestId:string;sellerKey:string;orderNumber:string;skuId:string;
    dispositionType:"unfulfilled_cancellation"|"physical_restock";quantity:number;sourceOrderRevision:number;
    availableAt:Date;evidence:Record<string,unknown>;receiptQuantities:Array<{receiptId:number;quantity:number}>}){
    return withTransaction(async(db)=>{
      input={...input,sellerKey:input.sellerKey.trim(),requestId:input.requestId.trim(),orderNumber:input.orderNumber.trim(),skuId:input.skuId.trim()};
      const receiptIds=new Set(input.receiptQuantities.map((value)=>value.receiptId));
      if(!input.requestId.trim()||!Number.isInteger(input.quantity)||input.quantity<=0||
          input.receiptQuantities.reduce((sum,value)=>sum+value.quantity,0)!==input.quantity||
          !input.receiptQuantities.length||receiptIds.size!==input.receiptQuantities.length||
          Object.keys(input.evidence).length===0)throw new Error("Complete disposition evidence is required.");
      const existing=await queryOne<any>(`SELECT disposition.id::text AS id,disposition.seller_key AS "sellerKey",
        orders.order_number AS "orderNumber",disposition.order_line_sku_id AS "skuId",disposition.disposition_type AS type,
        disposition.quantity,disposition.source_order_revision AS "sourceOrderRevision",disposition.available_at AS "availableAt",
        disposition.evidence FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        WHERE disposition.request_id=$1`,[input.requestId],db);
      if(existing){
        const mappings=await query<any>(`SELECT receipt_id AS "receiptId",quantity FROM inventory_stock_disposition_receipts WHERE disposition_id=$1 ORDER BY receipt_id`,[existing.id],db);
        if(existing.sellerKey!==input.sellerKey||existing.orderNumber!==input.orderNumber||existing.skuId!==input.skuId||
          existing.type!==input.dispositionType||existing.quantity!==input.quantity||existing.sourceOrderRevision!==input.sourceOrderRevision||
          existing.availableAt.toISOString()!==input.availableAt.toISOString()||canonicalEvidence(existing.evidence)!==canonicalEvidence(input.evidence)||
          JSON.stringify(mappings)!==JSON.stringify([...input.receiptQuantities].sort((a,b)=>a.receiptId-b.receiptId)))throw new Error("Disposition request ID conflicts.");
        return {id:existing.id,repeated:true};
      }
      const order=await queryOne<any>(`SELECT orders.id::text AS id,orders.order_time AS "orderTime",orders.lifecycle,
        orders.source_revision AS "sourceRevision" FROM seller_orders orders
        JOIN seller_order_lines line ON line.order_id=orders.id
        WHERE orders.seller_key=$1 AND orders.order_number=$2 AND line.sku_id=$3 FOR UPDATE OF orders`,
        [input.sellerKey,input.orderNumber,input.skuId],db);
      const sku=standardInventorySku(input.skuId);
      if(!order||sku===null||order.sourceRevision!==input.sourceOrderRevision||input.availableAt<order.orderTime)throw new Error("Disposition order evidence is stale or unsupported.");
      await enqueue(input.sellerKey,sku,order.orderTime,db);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`fifo:${input.sellerKey}:${sku}`]);
      const line=await queryOne<{id:string;orderedQuantity:number;matchedQuantity:number}>(`SELECT id::text AS id,
        ordered_quantity AS "orderedQuantity",matched_quantity AS "matchedQuantity" FROM inventory_fifo_lines
        WHERE order_id=$1 AND order_line_sku_id=$2 FOR UPDATE`,[order.id,input.skuId],db);
      if(!line||line.matchedQuantity<input.quantity)throw new Error("Disposition exceeds the line's matched inventory.");
      const shipped=await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM seller_order_revisions
        WHERE order_id=$1 AND lifecycle IN ('shipped_in_transit','shipped_delivered')`,[order.id],db);
      if(input.dispositionType==="unfulfilled_cancellation"&&(order.lifecycle!=="canceled"||(shipped?.count??0)>0||input.quantity!==line.orderedQuantity))
        throw new Error("Unfulfilled cancellation requires a fully matched, never-shipped canceled order.");
      const capacity=await query<any>(`SELECT allocation.receipt_id AS "receiptId",
        SUM(allocation.allocated_quantity)::int AS quantity FROM inventory_fifo_lines line
        JOIN inventory_fifo_revision_allocations allocation ON allocation.revision_id=line.current_revision_id
        WHERE line.id=$1 GROUP BY allocation.receipt_id`,[line.id],db);
      const prior=await query<any>(`SELECT mapping.receipt_id AS "receiptId",SUM(mapping.quantity)::int AS quantity
        FROM inventory_stock_dispositions disposition JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        WHERE disposition.order_id=$1 AND disposition.order_line_sku_id=$2
          AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction WHERE correction.disposition_id=disposition.id)
        GROUP BY mapping.receipt_id`,[order.id,input.skuId],db);
      for(const requested of input.receiptQuantities){
        if(!Number.isInteger(requested.receiptId)||!Number.isInteger(requested.quantity)||requested.quantity<=0)throw new Error("Disposition receipt quantities are invalid.");
        const available=(capacity.find((value)=>value.receiptId===requested.receiptId)?.quantity??0)-
          (prior.find((value)=>value.receiptId===requested.receiptId)?.quantity??0);
        if(requested.quantity>available)throw new Error("Disposition receipt lineage exceeds the active allocation.");
      }
      const disposition=await queryOne<{id:string}>(`INSERT INTO inventory_stock_dispositions
        (request_id,seller_key,order_id,order_line_sku_id,sku,disposition_type,quantity,source_order_revision,available_at,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id::text AS id`,
        [input.requestId,input.sellerKey,order.id,input.skuId,sku,input.dispositionType,input.quantity,
          input.sourceOrderRevision,input.availableAt,asJson(input.evidence)],db);
      if(!disposition)throw new Error("Failed to record stock disposition.");
      await execute(`INSERT INTO inventory_stock_disposition_receipts (disposition_id,receipt_id,quantity)
        SELECT $1,x."receiptId",x.quantity FROM jsonb_to_recordset($2::jsonb) AS x("receiptId" integer,quantity integer)`,
        [disposition.id,asJson(input.receiptQuantities)],db);
      return {id:disposition.id,repeated:false};
    });
  },

  async supersedeDisposition(input:{requestId:string;sellerKey:string;dispositionId:string;
    sourceOrderRevision:number;confirmedAt:Date;evidence:Record<string,unknown>}){
    return withTransaction(async(db)=>{
      input={...input,requestId:input.requestId.trim(),sellerKey:input.sellerKey.trim(),dispositionId:input.dispositionId.trim()};
      const existing=await queryOne<any>(`SELECT correction.id::text AS id,disposition.seller_key AS "sellerKey",
        correction.source_order_revision AS "sourceOrderRevision",correction.confirmed_at AS "confirmedAt",correction.evidence
        FROM inventory_stock_disposition_corrections correction JOIN inventory_stock_dispositions disposition
          ON disposition.id=correction.disposition_id WHERE correction.request_id=$1`,[input.requestId],db);
      if(existing){
        if(existing.sellerKey!==input.sellerKey||existing.sourceOrderRevision!==input.sourceOrderRevision||
          existing.confirmedAt.toISOString()!==input.confirmedAt.toISOString()||canonicalEvidence(existing.evidence)!==canonicalEvidence(input.evidence))
          throw new Error("Disposition correction request ID conflicts.");
        return {id:existing.id,repeated:true};
      }
      if(!Object.keys(input.evidence).length)throw new Error("Disposition correction evidence is required.");
      const disposition=await queryOne<any>(`SELECT disposition.id::text AS id,disposition.seller_key AS "sellerKey",disposition.sku,
        orders.order_time AS "orderTime",orders.source_revision AS "sourceRevision"
        FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        WHERE disposition.id=$1 AND disposition.seller_key=$2 FOR UPDATE`,[input.dispositionId,input.sellerKey],db);
      if(!disposition||disposition.sourceRevision!==input.sourceOrderRevision)throw new Error("Disposition correction evidence is stale.");
      await enqueue(input.sellerKey,disposition.sku,disposition.orderTime,db);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`fifo:${input.sellerKey}:${disposition.sku}`]);
      const row=await queryOne<{id:string}>(`INSERT INTO inventory_stock_disposition_corrections
        (request_id,disposition_id,action,source_order_revision,evidence,confirmed_at)
        VALUES ($1,$2,'provider_revision_accounts_for_return',$3,$4::jsonb,$5) RETURNING id::text AS id`,
        [input.requestId,input.dispositionId,input.sourceOrderRevision,asJson(input.evidence),input.confirmedAt],db);
      if(!row)throw new Error("Failed to correct disposition.");
      return {id:row.id,repeated:false};
    });
  },

  async findOrderAllocation(sellerKey:string,orderNumber:string){
    return query(`SELECT line.id::text AS id,line.order_line_sku_id AS "skuId",line.sku,line.state,
      line.hold_reason AS "holdReason",line.ordered_quantity AS "orderedQuantity",
      line.matched_quantity AS "matchedQuantity",line.unmatched_quantity AS "unmatchedQuantity",
      line.price_known_quantity AS "priceKnownQuantity",line.date_known_quantity AS "dateKnownQuantity",
      line.intake_market_total::float8 AS "intakeMarketTotal",line.weighted_days_held::float8 AS "weightedDaysHeld",
      line.current_revision_id::text AS "revisionId",queue.status AS "replayStatus",
      (queue.generation IS NOT NULL OR line.source_order_revision<>orders.source_revision) AS "allocationPending"
      FROM inventory_fifo_lines line JOIN seller_orders orders ON orders.id=line.order_id
      LEFT JOIN inventory_fifo_replay_queue queue ON queue.seller_key=line.seller_key AND queue.sku=line.sku
      WHERE line.seller_key=$1 AND orders.order_number=$2 ORDER BY line.order_line_sku_id`,[sellerKey.trim(),orderNumber.trim()]);
  },

  async listHolds(sellerKey:string){
    const queue=await query(`SELECT seller_key AS "sellerKey",sku,status,affected_from AS "affectedFrom",
      hold_reason AS "holdReason",updated_at AS "updatedAt"
      FROM inventory_fifo_replay_queue WHERE seller_key=$1 ORDER BY sku`,[sellerKey.trim()]);
    const lines=await query(`SELECT orders.order_number AS "orderNumber",line.order_line_sku_id AS "skuId",line.sku,
      line.hold_reason AS "holdReason",line.updated_at AS "updatedAt" FROM inventory_fifo_lines line
      JOIN seller_orders orders ON orders.id=line.order_id WHERE line.seller_key=$1 AND line.state='held'
      ORDER BY orders.order_time,orders.order_number,line.order_line_sku_id`,[sellerKey.trim()]);
    return {queue,lines};
  },
};

