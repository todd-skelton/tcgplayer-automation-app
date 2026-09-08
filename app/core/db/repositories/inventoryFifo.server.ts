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
  if(!/^[1-9]\d{0,9}$/.test(value))return null;
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
  allocations:Array<{supplyKey:string;receiptId:number;dispositionId:string|null;quantityCorrectionId:string|null;
    quantity:number;availableAt:string}>;
};

function lineFingerprint(value:SavedLine){
  return createHash("sha256").update(JSON.stringify({
    sourceOrderRevision:value.sourceOrderRevision,orderTime:value.orderTime.toISOString(),
    orderedQuantity:value.orderedQuantity,state:value.state,holdReason:value.holdReason,
    matchedQuantity:value.matchedQuantity,unmatchedQuantity:value.unmatchedQuantity,
    priceKnownQuantity:value.priceKnownQuantity,dateKnownQuantity:value.dateKnownQuantity,
    intakeMarketTotal:value.intakeMarketTotal,weightedDaysHeld:value.weightedDaysHeld,
    allocations:value.allocations.map((allocation)=>[allocation.supplyKey,allocation.receiptId,allocation.dispositionId,
      allocation.quantityCorrectionId,allocation.quantity,allocation.availableAt]),
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
      (revision_id,supply_key,receipt_id,disposition_id,quantity_correction_id,allocated_quantity,available_at)
    SELECT $1,x."supplyKey",x."receiptId",x."dispositionId"::bigint,x."quantityCorrectionId"::bigint,x.quantity,x."availableAt"::timestamptz
    FROM jsonb_to_recordset($2::jsonb) AS x(
      "supplyKey" text,"receiptId" integer,"dispositionId" text,"quantityCorrectionId" text,quantity integer,"availableAt" text)`,
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
      (revision_id,supply_key,receipt_id,disposition_id,quantity_correction_id,allocated_quantity,available_at)
    SELECT x."revisionId"::bigint,x."supplyKey",x."receiptId",x."dispositionId"::bigint,x."quantityCorrectionId"::bigint,x.quantity,x."availableAt"::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS x("revisionId" text,"supplyKey" text,"receiptId" integer,
      "dispositionId" text,"quantityCorrectionId" text,quantity integer,"availableAt" text)`,[asJson(allocations)],db);
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
      const supported=current.map((line)=>({...line,sku:standardInventorySku(line.skuId)}))
        .filter((line):line is typeof line&{sku:number}=>line.sku!==null);
      if(supported.length)await execute(`INSERT INTO inventory_fifo_lines
          (seller_key,order_id,order_line_sku_id,sku,order_time,ordered_quantity,source_order_revision,state,
           matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity)
        SELECT $1,$2::bigint,x."skuId",x.sku,$3::timestamptz,x.quantity,$4,'pending',0,x.quantity,0,0
        FROM jsonb_to_recordset($5::jsonb) AS x("skuId" text,sku integer,quantity integer)
        ON CONFLICT (order_id,order_line_sku_id) DO NOTHING`,
        [order.sellerKey,orderId,order.orderTime,order.sourceRevision,asJson(supported)],db);
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

  async processNextReplay(expectedSellerKey?:string){
    return withTransaction(async(db)=>{
      const queued=await queryOne<{sellerKey:string;sku:number;affectedFrom:Date}>(`SELECT seller_key AS "sellerKey",sku,
        affected_from AS "affectedFrom" FROM inventory_fifo_replay_queue
        WHERE (status='pending' OR (status='processing' AND claim_expires_at<NOW()))
          AND ($1::text IS NULL OR seller_key=$1)
        ORDER BY updated_at,seller_key,sku FOR UPDATE SKIP LOCKED LIMIT 1`,[expectedSellerKey?.trim()||null],db);
      if(!queued)return null;
      await execute(`UPDATE inventory_fifo_replay_queue SET status='processing',claim_token=$3,
        claim_expires_at=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE seller_key=$1 AND sku=$2`,
        [queued.sellerKey,queued.sku,randomUUID()],db);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`fifo:${queued.sellerKey}:${queued.sku}`]);
      const opening=await queryOne<{cutoffAt:Date}>(`SELECT cutoff_at AS "cutoffAt" FROM inventory_opening_balance_runs
        WHERE seller_key=$1 AND status='applied'`,[queued.sellerKey],db);
      if(!opening)return holdQueue(queued.sellerKey,queued.sku,"missing_applied_opening_balance",db);
      const changedOrderTime=await queryOne<{lineId:string}>(`SELECT saved.id::text AS "lineId"
        FROM inventory_fifo_lines saved JOIN seller_orders orders ON orders.id=saved.order_id
        WHERE saved.seller_key=$1 AND saved.sku=$2 AND saved.current_revision_id IS NOT NULL
          AND saved.order_time IS DISTINCT FROM orders.order_time
          AND (saved.order_time>=$3 OR orders.order_time>=$3) LIMIT 1`,[queued.sellerKey,queued.sku,opening.cutoffAt],db);
      if(changedOrderTime)return holdQueue(queued.sellerKey,queued.sku,
        `order_time_change_requires_reconciliation:${changedOrderTime.lineId}`,db);
      const unknownInitialOrderTime=await queryOne<{orderId:string}>(`SELECT orders.id::text AS "orderId"
        FROM seller_orders orders JOIN seller_order_revisions revision
          ON revision.order_id=orders.id AND revision.revision_number=1
        CROSS JOIN LATERAL jsonb_array_elements(revision.line_evidence) evidence
        WHERE orders.seller_key=$1 AND revision.order_time IS NULL AND evidence->>'skuId'=$2::text LIMIT 1`,
        [queued.sellerKey,queued.sku],db);
      if(unknownInitialOrderTime)return holdQueue(queued.sellerKey,queued.sku,
        `historical_order_time_unknown:${unknownInitialOrderTime.orderId}`,db);
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
              AND disposition.available_at>=previous.cutoff_at AND disposition.available_at<observation.cutoff_at),0)
          - COALESCE((SELECT SUM((evidence->>'quantity')::int)::int
            FROM seller_orders orders JOIN seller_order_revisions revision
              ON revision.order_id=orders.id AND revision.revision_number=1
            CROSS JOIN LATERAL jsonb_array_elements(revision.line_evidence) evidence
            WHERE orders.seller_key=difference.seller_key
              AND revision.order_time>=previous.cutoff_at AND revision.order_time<observation.cutoff_at
              AND evidence->>'skuId'=difference.sku::text),0)
          + COALESCE((SELECT SUM(correction.released_quantity)::int
            FROM inventory_order_quantity_corrections correction
            WHERE correction.seller_key=difference.seller_key AND correction.sku=difference.sku
              AND correction.available_at>=previous.cutoff_at AND correction.available_at<observation.cutoff_at),0)
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
      const invalidatedCorrection=await queryOne<{id:string}>(`SELECT MIN(correction.id)::text AS id
        FROM inventory_stock_dispositions disposition
        JOIN inventory_stock_disposition_corrections correction ON correction.disposition_id=disposition.id
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=disposition.order_id
          AND current_line.sku_id=disposition.order_line_sku_id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2
        GROUP BY disposition.order_id,disposition.order_line_sku_id,current_line.ordered_quantity
        HAVING MAX(disposition.source_ordered_quantity)-COALESCE(current_line.ordered_quantity,0)<SUM(disposition.quantity)
        LIMIT 1`,[queued.sellerKey,queued.sku],db);
      if(invalidatedCorrection)return holdQueue(queued.sellerKey,queued.sku,
        `return_correction_invalidated:${invalidatedCorrection.id}`,db);
      const invalidatedCancellation=await queryOne<{id:string}>(`SELECT disposition.id::text AS id
        FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2 AND disposition.disposition_type='unfulfilled_cancellation'
          AND orders.lifecycle<>'canceled' LIMIT 1`,[queued.sellerKey,queued.sku],db);
      if(invalidatedCancellation)return holdQueue(queued.sellerKey,queued.sku,
        `unfulfilled_cancellation_invalidated:${invalidatedCancellation.id}`,db);
      const invalidatedDispositionChronology=await queryOne<{id:string}>(`SELECT disposition.id::text AS id
        FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2 AND orders.order_time>disposition.available_at LIMIT 1`,
        [queued.sellerKey,queued.sku],db);
      if(invalidatedDispositionChronology)return holdQueue(queued.sellerKey,queued.sku,
        `stock_disposition_chronology_invalidated:${invalidatedDispositionChronology.id}`,db);
      const invalidatedQuantityCorrection=await queryOne<{id:string}>(`SELECT correction.id::text AS id
        FROM inventory_order_quantity_corrections correction JOIN seller_orders orders ON orders.id=correction.order_id
        LEFT JOIN seller_order_lines line ON line.order_id=orders.id AND line.sku_id=correction.order_line_sku_id
        WHERE correction.seller_key=$1 AND correction.sku=$2 AND orders.source_revision>correction.source_order_revision
          AND (COALESCE(line.ordered_quantity,0)>correction.corrected_quantity
            OR orders.order_time>correction.available_at) LIMIT 1`,[queued.sellerKey,queued.sku],db);
      if(invalidatedQuantityCorrection)return holdQueue(queued.sellerKey,queued.sku,
        `order_quantity_correction_invalidated:${invalidatedQuantityCorrection.id}`,db);

      const current=await query<any>(`SELECT orders.id::text AS "orderId",orders.order_number AS "orderNumber",
        orders.order_time AS "orderTime",orders.lifecycle,orders.source_revision AS "sourceRevision",
        line.sku_id AS "skuId",line.ordered_quantity AS quantity
        FROM seller_orders orders JOIN seller_order_lines line ON line.order_id=orders.id
        WHERE orders.seller_key=$1 AND line.sku_id=$2::text`,[queued.sellerKey,queued.sku],db);
      const removed=await query<any>(`SELECT line.order_id::text AS "orderId",orders.order_number AS "orderNumber",
        orders.order_time AS "orderTime",orders.lifecycle,orders.source_revision AS "sourceRevision",
        line.order_line_sku_id AS "skuId",0::int AS quantity
        FROM inventory_fifo_lines line JOIN seller_orders orders ON orders.id=line.order_id
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=line.order_id
          AND current_line.sku_id=line.order_line_sku_id
        WHERE line.seller_key=$1 AND line.sku=$2 AND current_line.order_id IS NULL`,[queued.sellerKey,queued.sku],db);
      const demand=[...current,...removed];
      const amendedLineAddition=await queryOne<{lineId:string}>(`SELECT saved.id::text AS "lineId"
        FROM inventory_fifo_lines saved JOIN seller_orders orders ON orders.id=saved.order_id
        JOIN seller_order_revisions initial ON initial.order_id=orders.id AND initial.revision_number=1
        WHERE saved.seller_key=$1 AND saved.sku=$2 AND saved.current_revision_id IS NULL
          AND orders.order_time>=$3 AND orders.source_revision>1
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(initial.line_evidence) evidence
            WHERE evidence->>'skuId'=saved.order_line_sku_id) LIMIT 1`,[queued.sellerKey,queued.sku,opening.cutoffAt],db);
      if(amendedLineAddition)return holdQueue(queued.sellerKey,queued.sku,
        `order_line_addition_requires_correction:${amendedLineAddition.lineId}`,db);
      const unresolvedQuantityChange=await queryOne<{lineId:string;direction:string}>(`SELECT saved.id::text AS "lineId",
          CASE WHEN COALESCE(current_line.ordered_quantity,0)>saved.ordered_quantity THEN 'increase' ELSE 'decrease' END AS direction
        FROM inventory_fifo_lines saved
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=saved.order_id
          AND current_line.sku_id=saved.order_line_sku_id
        JOIN seller_orders orders ON orders.id=saved.order_id
        WHERE saved.seller_key=$1 AND saved.sku=$2
          AND orders.order_time>=$3
          AND COALESCE(current_line.ordered_quantity,0)<>saved.ordered_quantity
          AND (COALESCE(current_line.ordered_quantity,0)>saved.ordered_quantity
            OR COALESCE(current_line.ordered_quantity,0)<saved.matched_quantity)
          AND NOT EXISTS (SELECT 1 FROM inventory_order_quantity_corrections correction
            WHERE correction.order_id=saved.order_id AND correction.order_line_sku_id=saved.order_line_sku_id
              AND correction.source_order_revision=orders.source_revision)
          AND NOT EXISTS (SELECT 1 FROM inventory_stock_dispositions disposition
            JOIN inventory_stock_disposition_corrections correction ON correction.disposition_id=disposition.id
            WHERE disposition.order_id=saved.order_id AND disposition.order_line_sku_id=saved.order_line_sku_id
              AND correction.source_order_revision=orders.source_revision)
        ORDER BY orders.order_time,orders.order_number LIMIT 1`,[queued.sellerKey,queued.sku,opening.cutoffAt],db);
      if(unresolvedQuantityChange)return holdQueue(queued.sellerKey,queued.sku,
        `order_quantity_${unresolvedQuantityChange.direction}_requires_correction:${unresolvedQuantityChange.lineId}`,db);
      const dispositionRows=await query<any>(`SELECT disposition.id::text AS id,disposition.order_id::text AS "orderId",
        disposition.order_line_sku_id AS "skuId",disposition.disposition_type AS type,mapping.receipt_id AS "receiptId",
        mapping.source_supply_key AS "sourceSupplyKey",mapping.quantity,
        'restock:'||disposition.id::text||':'||mapping.source_supply_key AS "restockSupplyKey",
        EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction
          WHERE correction.disposition_id=disposition.id) AS corrected FROM inventory_stock_dispositions disposition
        JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2`,[queued.sellerKey,queued.sku],db);
      const quantityCorrectionRows=await query<any>(`SELECT correction.id::text AS id,correction.order_id::text AS "orderId",
        correction.order_line_sku_id AS "skuId",mapping.receipt_id AS "receiptId",
        mapping.source_supply_key AS "sourceSupplyKey",mapping.quantity,
        'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key AS "restockSupplyKey"
        FROM inventory_order_quantity_corrections correction
        JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
        WHERE correction.seller_key=$1 AND correction.sku=$2`,[queued.sellerKey,queued.sku],db);
      const dispositionEdgeBySupply=new Map([...dispositionRows,...quantityCorrectionRows]
        .map((row)=>[row.restockSupplyKey,row]));
      const excludedOrigins=(supplyKey:string)=>{
        const origins=new Set<string>();const visited=new Set<string>();let current=supplyKey;
        while(!visited.has(current)){
          visited.add(current);const edge=dispositionEdgeBySupply.get(current);if(!edge)break;
          origins.add(`${edge.orderId}:${edge.skuId}`);current=edge.sourceSupplyKey;
        }
        return [...origins].sort();
      };
      const lots=await query<any>(`WITH raw_supply AS (
        SELECT 'receipt:'||receipt.receipt_id::text AS "supplyKey",
          receipt.receipt_id AS "receiptId",NULL::text AS "dispositionId",NULL::text AS "quantityCorrectionId",
          receipt.original_quantity AS quantity,
          opening.cutoff_at AS "availableAt",receipt.fifo_precedence AS "fifoPrecedence",
          receipt.intake_at AS "intakeAt",receipt.market_value::text AS "marketValue",NULL::text AS "excludedLineKey"
        FROM inventory_receipts receipt JOIN inventory_opening_balance_runs opening
          ON opening.id=receipt.opening_balance_run_id AND opening.status='applied'
        WHERE receipt.seller_key=$1 AND receipt.sku=$2 AND receipt.receipt_kind='opening_balance'
        UNION ALL
        SELECT 'receipt:'||receipt.receipt_id::text,receipt.receipt_id,NULL::text,NULL::text,link.planned_quantity,
          link.live_at,receipt.fifo_precedence,receipt.intake_at,receipt.market_value::text,NULL::text
        FROM inventory_receipts receipt JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
        WHERE receipt.seller_key=$1 AND link.target_seller_key=$1 AND receipt.sku=$2
          AND receipt.receipt_kind='received' AND link.live_at IS NOT NULL AND link.live_at>=$3
        UNION ALL
        SELECT 'restock:'||disposition.id::text||':'||mapping.source_supply_key,mapping.receipt_id,
          disposition.id::text,NULL::text,mapping.quantity,disposition.available_at,receipt.fifo_precedence,
          receipt.intake_at,receipt.market_value::text,disposition.order_id::text||':'||disposition.order_line_sku_id
        FROM inventory_stock_dispositions disposition
        JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2
        UNION ALL
        SELECT 'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key,mapping.receipt_id,
          NULL::text,correction.id::text,mapping.quantity,correction.available_at,receipt.fifo_precedence,
          receipt.intake_at,receipt.market_value::text,correction.order_id::text||':'||correction.order_line_sku_id
        FROM inventory_order_quantity_corrections correction
        JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
        JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
        WHERE correction.seller_key=$1 AND correction.sku=$2
      ) SELECT raw_supply."supplyKey",raw_supply."receiptId",raw_supply."dispositionId",raw_supply."quantityCorrectionId",
          raw_supply.quantity-COALESCE((SELECT SUM(mapping.quantity)::int
            FROM (
              SELECT mapping.source_supply_key,mapping.quantity,disposition.seller_key,disposition.sku
              FROM inventory_stock_disposition_receipts mapping
              JOIN inventory_stock_dispositions disposition ON disposition.id=mapping.disposition_id
              JOIN inventory_stock_disposition_corrections correction ON correction.disposition_id=disposition.id
              UNION ALL
              SELECT mapping.source_supply_key,mapping.quantity,correction.seller_key,correction.sku
              FROM inventory_order_quantity_correction_allocations mapping
              JOIN inventory_order_quantity_corrections correction ON correction.id=mapping.correction_id
            ) mapping WHERE mapping.source_supply_key=raw_supply."supplyKey"
              AND mapping.seller_key=$1 AND mapping.sku=$2),0) AS quantity,
          raw_supply."availableAt",raw_supply."fifoPrecedence",raw_supply."intakeAt",raw_supply."marketValue",
          raw_supply."excludedLineKey"
        FROM raw_supply`,[queued.sellerKey,queued.sku,opening.cutoffAt],db);
      const supplies:FifoSupplyLot[]=lots.filter((row)=>row.quantity>0).map((row)=>({
        supplyKey:row.supplyKey,receiptId:row.receiptId,dispositionId:row.dispositionId,
        quantityCorrectionId:row.quantityCorrectionId,
        excludedLineKeys:excludedOrigins(row.supplyKey),
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
        WHERE orders.seller_key=$1 AND revision.lifecycle IN ('shipped_in_transit','shipped_delivered')
          AND (EXISTS (SELECT 1 FROM seller_order_lines line WHERE line.order_id=orders.id
              AND line.sku_id=$2::text)
            OR EXISTS (SELECT 1 FROM inventory_fifo_lines line WHERE line.order_id=orders.id AND line.sku=$2::integer))`,
        [queued.sellerKey,queued.sku],db);
      const shippedOrders=new Set(shipped.map((row)=>row.orderId));
      const dispositionsByLine=new Map<string,typeof dispositionRows>();
      for(const disposition of dispositionRows){
        const lineKey=`${disposition.orderId}:${disposition.skuId}`;
        dispositionsByLine.set(lineKey,[...(dispositionsByLine.get(lineKey)??[]),disposition]);
      }
      for(const disposition of dispositionRows){
        if(disposition.corrected)continue;
        const result=results.get(`${disposition.orderId}:${disposition.skuId}`);
        const allocated=result?.allocations.filter((allocation)=>allocation.supplyKey===disposition.sourceSupplyKey&&
          allocation.receiptId===disposition.receiptId)
          .reduce((sum,allocation)=>sum+allocation.quantity,0)??0;
        const disposed=dispositionRows.filter((row)=>row.orderId===disposition.orderId&&row.skuId===disposition.skuId&&
          row.sourceSupplyKey===disposition.sourceSupplyKey).reduce((sum,row)=>sum+row.quantity,0);
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
    availableAt:Date;evidence:Record<string,unknown>;sourceAllocations:Array<{supplyKey:string;receiptId:number;quantity:number}>}){
    return withTransaction(async(db)=>{
      input={...input,sellerKey:input.sellerKey.trim(),requestId:input.requestId.trim(),orderNumber:input.orderNumber.trim(),skuId:input.skuId.trim()};
      const supplyKeys=new Set(input.sourceAllocations.map((value)=>value.supplyKey));
      if(!input.requestId.trim()||!Number.isInteger(input.quantity)||input.quantity<=0||
          input.sourceAllocations.reduce((sum,value)=>sum+value.quantity,0)!==input.quantity||
          !input.sourceAllocations.length||supplyKeys.size!==input.sourceAllocations.length||
          Object.keys(input.evidence).length===0)throw new Error("Complete disposition evidence is required.");
      const findReplay=async()=>{
        const existing=await queryOne<any>(`SELECT disposition.id::text AS id,disposition.seller_key AS "sellerKey",
          orders.order_number AS "orderNumber",disposition.order_line_sku_id AS "skuId",disposition.disposition_type AS type,
          disposition.quantity,disposition.source_order_revision AS "sourceOrderRevision",disposition.available_at AS "availableAt",
          disposition.evidence FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
          WHERE disposition.request_id=$1`,[input.requestId],db);
        if(!existing)return null;
        const mappings=await query<any>(`SELECT source_supply_key AS "supplyKey",receipt_id AS "receiptId",quantity
          FROM inventory_stock_disposition_receipts WHERE disposition_id=$1 ORDER BY source_supply_key`,[existing.id],db);
        if(existing.sellerKey!==input.sellerKey||existing.orderNumber!==input.orderNumber||existing.skuId!==input.skuId||
          existing.type!==input.dispositionType||existing.quantity!==input.quantity||existing.sourceOrderRevision!==input.sourceOrderRevision||
          existing.availableAt.toISOString()!==input.availableAt.toISOString()||canonicalEvidence(existing.evidence)!==canonicalEvidence(input.evidence)||
          JSON.stringify(mappings)!==JSON.stringify([...input.sourceAllocations].sort((a,b)=>a.supplyKey<b.supplyKey?-1:a.supplyKey>b.supplyKey?1:0)))throw new Error("Disposition request ID conflicts.");
        return {id:existing.id,repeated:true};
      };
      const replay=await findReplay();if(replay)return replay;
      const order=await queryOne<any>(`SELECT orders.id::text AS id,orders.order_time AS "orderTime",orders.lifecycle,
        orders.source_revision AS "sourceRevision" FROM seller_orders orders
        JOIN seller_order_lines line ON line.order_id=orders.id
        WHERE orders.seller_key=$1 AND orders.order_number=$2 AND line.sku_id=$3 FOR UPDATE OF orders`,
        [input.sellerKey,input.orderNumber,input.skuId],db);
      const sku=standardInventorySku(input.skuId);
      if(!order||sku===null||order.sourceRevision!==input.sourceOrderRevision||input.availableAt<order.orderTime)throw new Error("Disposition order evidence is stale or unsupported.");
      const reserved=await queryOne<{sellerKey:string}>(`INSERT INTO inventory_fifo_replay_queue
          (seller_key,sku,affected_from,status,generation,claim_token,claim_expires_at)
        VALUES ($1,$2,$3,'processing',1,$4,NOW()+INTERVAL '5 minutes')
        ON CONFLICT (seller_key,sku) DO UPDATE SET status='processing',claim_token=EXCLUDED.claim_token,
          claim_expires_at=EXCLUDED.claim_expires_at,hold_reason=NULL,updated_at=NOW()
        WHERE inventory_fifo_replay_queue.status='held' AND inventory_fifo_replay_queue.hold_reason IN
          ('cancellation_requires_disposition','canceled_after_shipping_requires_restock')
          OR inventory_fifo_replay_queue.status='held'
            AND inventory_fifo_replay_queue.hold_reason LIKE 'unexplained_inventory_difference:%'
        RETURNING seller_key AS "sellerKey"`,[input.sellerKey,sku,order.orderTime,randomUUID()],db);
      if(!reserved){const raced=await findReplay();if(raced)return raced;
        throw new Error("FIFO allocation must be current before recording a disposition.");}
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`fifo:${input.sellerKey}:${sku}`]);
      const line=await queryOne<{id:string;orderTime:Date;sourceOrderRevision:number;orderedQuantity:number;matchedQuantity:number}>(`SELECT id::text AS id,
        order_time AS "orderTime",source_order_revision AS "sourceOrderRevision",
        ordered_quantity AS "orderedQuantity",matched_quantity AS "matchedQuantity" FROM inventory_fifo_lines
        WHERE order_id=$1 AND order_line_sku_id=$2 FOR UPDATE`,[order.id,input.skuId],db);
      if(!line||line.sourceOrderRevision!==order.sourceRevision||line.orderTime.getTime()!==order.orderTime.getTime()||
          line.matchedQuantity<input.quantity)throw new Error("Disposition exceeds or does not match the current FIFO allocation.");
      const shipped=await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM seller_order_revisions
        WHERE order_id=$1 AND lifecycle IN ('shipped_in_transit','shipped_delivered')`,[order.id],db);
      if(input.dispositionType==="unfulfilled_cancellation"&&(order.lifecycle!=="canceled"||(shipped?.count??0)>0||input.quantity!==line.orderedQuantity))
        throw new Error("Unfulfilled cancellation requires a fully matched, never-shipped canceled order.");
      const capacity=await query<any>(`SELECT allocation.supply_key AS "supplyKey",allocation.receipt_id AS "receiptId",
        SUM(allocation.allocated_quantity)::int AS quantity FROM inventory_fifo_lines line
        JOIN inventory_fifo_revision_allocations allocation ON allocation.revision_id=line.current_revision_id
        WHERE line.id=$1 GROUP BY allocation.supply_key,allocation.receipt_id`,[line.id],db);
      const prior=await query<any>(`SELECT mapping.source_supply_key AS "supplyKey",SUM(mapping.quantity)::int AS quantity
        FROM inventory_stock_dispositions disposition JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        WHERE disposition.order_id=$1 AND disposition.order_line_sku_id=$2
        GROUP BY mapping.source_supply_key`,[order.id,input.skuId],db);
      for(const requested of input.sourceAllocations){
        if(!requested.supplyKey?.trim()||!Number.isInteger(requested.receiptId)||!Number.isInteger(requested.quantity)||requested.quantity<=0)
          throw new Error("Disposition source allocations are invalid.");
        const source=capacity.find((value)=>value.supplyKey===requested.supplyKey&&value.receiptId===requested.receiptId);
        const available=(source?.quantity??0)-(prior.find((value)=>value.supplyKey===requested.supplyKey)?.quantity??0);
        if(requested.quantity>available)throw new Error("Disposition receipt lineage exceeds the active allocation.");
      }
      const disposition=await queryOne<{id:string}>(`INSERT INTO inventory_stock_dispositions
        (request_id,seller_key,order_id,order_line_sku_id,sku,disposition_type,quantity,source_order_revision,
         source_ordered_quantity,available_at,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id::text AS id`,
        [input.requestId,input.sellerKey,order.id,input.skuId,sku,input.dispositionType,input.quantity,
          input.sourceOrderRevision,line.orderedQuantity,input.availableAt,asJson(input.evidence)],db);
      if(!disposition)throw new Error("Failed to record stock disposition.");
      await execute(`INSERT INTO inventory_stock_disposition_receipts (disposition_id,source_supply_key,receipt_id,quantity)
        SELECT $1,x."supplyKey",x."receiptId",x.quantity FROM jsonb_to_recordset($2::jsonb)
          AS x("supplyKey" text,"receiptId" integer,quantity integer)`,
        [disposition.id,asJson(input.sourceAllocations)],db);
      await execute(`UPDATE inventory_fifo_replay_queue SET status='pending',claim_token=NULL,claim_expires_at=NULL,
        hold_reason=NULL,updated_at=NOW() WHERE seller_key=$1 AND sku=$2`,[input.sellerKey,sku],db);
      return {id:disposition.id,repeated:false};
    });
  },

  async supersedeDisposition(input:{requestId:string;sellerKey:string;dispositionId:string;
    sourceOrderRevision:number;confirmedAt:Date;evidence:Record<string,unknown>}){
    return withTransaction(async(db)=>{
      input={...input,requestId:input.requestId.trim(),sellerKey:input.sellerKey.trim(),dispositionId:input.dispositionId.trim()};
      const findReplay=async()=>{
        const existing=await queryOne<any>(`SELECT correction.id::text AS id,correction.disposition_id::text AS "dispositionId",
          disposition.seller_key AS "sellerKey",correction.source_order_revision AS "sourceOrderRevision",
          correction.confirmed_at AS "confirmedAt",correction.evidence
          FROM inventory_stock_disposition_corrections correction JOIN inventory_stock_dispositions disposition
            ON disposition.id=correction.disposition_id WHERE correction.request_id=$1`,[input.requestId],db);
        if(!existing)return null;
        if(existing.sellerKey!==input.sellerKey||existing.dispositionId!==input.dispositionId||
          existing.sourceOrderRevision!==input.sourceOrderRevision||
          existing.confirmedAt.toISOString()!==input.confirmedAt.toISOString()||canonicalEvidence(existing.evidence)!==canonicalEvidence(input.evidence))
          throw new Error("Disposition correction request ID conflicts.");
        return {id:existing.id,repeated:true};
      };
      const replay=await findReplay();if(replay)return replay;
      if(!Object.keys(input.evidence).length)throw new Error("Disposition correction evidence is required.");
      const target=await queryOne<{sku:number;orderTime:Date}>(`SELECT disposition.sku,orders.order_time AS "orderTime"
        FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        WHERE disposition.id=$1 AND disposition.seller_key=$2`,[input.dispositionId,input.sellerKey],db);
      if(!target)throw new Error("Disposition correction evidence is stale or predates the disposition.");
      await enqueue(input.sellerKey,target.sku,target.orderTime,db);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`fifo:${input.sellerKey}:${target.sku}`]);
      const raced=await findReplay();if(raced)return raced;
      const disposition=await queryOne<any>(`SELECT disposition.id::text AS id,disposition.seller_key AS "sellerKey",disposition.sku,
        disposition.available_at AS "availableAt",disposition.quantity,
        disposition.source_order_revision AS "dispositionSourceRevision",
        disposition.source_ordered_quantity AS "sourceOrderedQuantity",orders.order_time AS "orderTime",
        orders.source_revision AS "currentSourceRevision",COALESCE(line.ordered_quantity,0)::int AS "currentQuantity",
        (SELECT COALESCE(SUM(other.quantity),0)::int FROM inventory_stock_dispositions other
          JOIN inventory_stock_disposition_corrections other_correction ON other_correction.disposition_id=other.id
          WHERE other.order_id=disposition.order_id AND other.order_line_sku_id=disposition.order_line_sku_id
            AND other_correction.source_order_revision=$3) AS "alreadyCorrectedQuantity"
        FROM inventory_stock_dispositions disposition JOIN seller_orders orders ON orders.id=disposition.order_id
        LEFT JOIN seller_order_lines line ON line.order_id=orders.id AND line.sku_id=disposition.order_line_sku_id
        WHERE disposition.id=$1 AND disposition.seller_key=$2 FOR UPDATE OF disposition`,
        [input.dispositionId,input.sellerKey,input.sourceOrderRevision],db);
      if(!disposition||disposition.currentSourceRevision!==input.sourceOrderRevision||
          input.sourceOrderRevision<=disposition.dispositionSourceRevision||
          disposition.sourceOrderedQuantity-disposition.currentQuantity<disposition.alreadyCorrectedQuantity+disposition.quantity||
          input.confirmedAt<disposition.availableAt)
        throw new Error("Disposition correction evidence is stale or predates the disposition.");
      const row=await queryOne<{id:string}>(`INSERT INTO inventory_stock_disposition_corrections
        (request_id,disposition_id,action,source_order_revision,evidence,confirmed_at)
        VALUES ($1,$2,'provider_revision_accounts_for_return',$3,$4::jsonb,$5) RETURNING id::text AS id`,
        [input.requestId,input.dispositionId,input.sourceOrderRevision,asJson(input.evidence),input.confirmedAt],db);
      if(!row)throw new Error("Failed to correct disposition.");
      return {id:row.id,repeated:false};
    });
  },

  async recordQuantityCorrection(input:{requestId:string;sellerKey:string;orderNumber:string;skuId:string;
    sourceOrderRevision:number;availableAt:Date;evidence:Record<string,unknown>;
    sourceAllocations:Array<{supplyKey:string;receiptId:number;quantity:number}>}){
    return withTransaction(async(db)=>{
      input={...input,requestId:input.requestId.trim(),sellerKey:input.sellerKey.trim(),
        orderNumber:input.orderNumber.trim(),skuId:input.skuId.trim()};
      const findReplay=async()=>{
        const existing=await queryOne<any>(`SELECT correction.id::text AS id,correction.seller_key AS "sellerKey",
          orders.order_number AS "orderNumber",correction.order_line_sku_id AS "skuId",
          correction.source_order_revision AS "sourceOrderRevision",correction.available_at AS "availableAt",
          correction.evidence FROM inventory_order_quantity_corrections correction
          JOIN seller_orders orders ON orders.id=correction.order_id WHERE correction.request_id=$1`,[input.requestId],db);
        if(!existing)return null;
        const mappings=await query<any>(`SELECT source_supply_key AS "supplyKey",receipt_id AS "receiptId",quantity
          FROM inventory_order_quantity_correction_allocations WHERE correction_id=$1 ORDER BY source_supply_key`,[existing.id],db);
        if(existing.sellerKey!==input.sellerKey||existing.orderNumber!==input.orderNumber||existing.skuId!==input.skuId||
            existing.sourceOrderRevision!==input.sourceOrderRevision||existing.availableAt.toISOString()!==input.availableAt.toISOString()||
            canonicalEvidence(existing.evidence)!==canonicalEvidence(input.evidence)||
            JSON.stringify(mappings)!==JSON.stringify([...input.sourceAllocations].sort((a,b)=>a.supplyKey<b.supplyKey?-1:a.supplyKey>b.supplyKey?1:0)))
          throw new Error("Quantity correction request ID conflicts.");
        return {id:existing.id,repeated:true};
      };
      const replay=await findReplay();if(replay)return replay;
      if(!input.requestId||!Object.keys(input.evidence).length||!input.sourceAllocations.length||
          new Set(input.sourceAllocations.map((value)=>value.supplyKey)).size!==input.sourceAllocations.length)
        throw new Error("Complete quantity correction evidence and source allocations are required.");
      const sku=standardInventorySku(input.skuId);if(sku===null)throw new Error("Quantity correction SKU is unsupported.");
      const target=await queryOne<{orderId:string;orderTime:Date}>(`SELECT orders.id::text AS "orderId",orders.order_time AS "orderTime"
        FROM seller_orders orders WHERE orders.seller_key=$1 AND orders.order_number=$2`,[input.sellerKey,input.orderNumber],db);
      if(!target)throw new Error("Quantity correction order was not found.");
      const reserved=await queryOne<{sellerKey:string}>(`UPDATE inventory_fifo_replay_queue SET status='processing',
          claim_token=$3,claim_expires_at=NOW()+INTERVAL '5 minutes',hold_reason=NULL,updated_at=NOW()
        WHERE seller_key=$1 AND sku=$2 AND status='held'
          AND (hold_reason LIKE 'order_quantity_decrease_requires_correction:%'
            OR hold_reason LIKE 'unexplained_inventory_difference:%')
        RETURNING seller_key AS "sellerKey"`,[input.sellerKey,sku,randomUUID()],db);
      if(!reserved){const raced=await findReplay();if(raced)return raced;
        throw new Error("FIFO must hold an unresolved quantity decrease before correction.");}
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`fifo:${input.sellerKey}:${sku}`]);
      const line=await queryOne<any>(`SELECT saved.id::text AS id,saved.ordered_quantity AS "previousQuantity",
          saved.matched_quantity AS "previousMatchedQuantity",
          saved.source_order_revision AS "previousSourceRevision",COALESCE(current_line.ordered_quantity,0)::int AS "currentQuantity",
          orders.source_revision AS "currentSourceRevision",revision.observed_at AS "revisionObservedAt",
          (SELECT COUNT(*)::int FROM inventory_stock_dispositions disposition
            WHERE disposition.order_id=orders.id AND disposition.order_line_sku_id=saved.order_line_sku_id
              AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections corrected
                WHERE corrected.disposition_id=disposition.id)) AS "activeDispositionCount"
        FROM seller_orders orders JOIN inventory_fifo_lines saved ON saved.order_id=orders.id AND saved.order_line_sku_id=$3
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=orders.id AND current_line.sku_id=saved.order_line_sku_id
        JOIN seller_order_revisions revision ON revision.order_id=orders.id AND revision.revision_number=orders.source_revision
        WHERE orders.id=$1 AND orders.seller_key=$2`,[target.orderId,input.sellerKey,input.skuId],db);
      const released=Math.max(0,(line?.previousMatchedQuantity??0)-(line?.currentQuantity??0));
      if(!line||line.currentSourceRevision!==input.sourceOrderRevision||line.previousSourceRevision>=input.sourceOrderRevision||
          line.activeDispositionCount>0||released<=0||input.availableAt<line.revisionObservedAt)
        throw new Error("Quantity correction source revision is stale, disposition-backed, or not a decrease.");
      const allocations=await query<any>(`SELECT allocation.supply_key AS "supplyKey",allocation.receipt_id AS "receiptId",
          allocation.allocated_quantity AS quantity FROM inventory_fifo_revision_allocations allocation
        JOIN inventory_fifo_lines saved ON saved.current_revision_id=allocation.revision_id
        JOIN inventory_receipts receipt ON receipt.receipt_id=allocation.receipt_id
        WHERE saved.id=$1 ORDER BY receipt.fifo_precedence DESC,receipt.intake_at DESC NULLS LAST,
          receipt.receipt_id DESC,allocation.supply_key DESC`,[line.id],db);
      let needed=Math.min(released,allocations.reduce((sum,row)=>sum+row.quantity,0));
      const expected:Array<{supplyKey:string;receiptId:number;quantity:number}>=[];
      for(const allocation of allocations){if(needed<=0)break;const quantity=Math.min(needed,allocation.quantity);
        expected.push({supplyKey:allocation.supplyKey,receiptId:allocation.receiptId,quantity});needed-=quantity;}
      const supplied=[...input.sourceAllocations].sort((a,b)=>a.supplyKey>b.supplyKey?1:a.supplyKey<b.supplyKey?-1:0);
      const expectedSorted=[...expected].sort((a,b)=>a.supplyKey>b.supplyKey?1:a.supplyKey<b.supplyKey?-1:0);
      if(!expected.length||JSON.stringify(supplied)!==JSON.stringify(expectedSorted))
        throw new Error("Quantity correction must release the newest exact active allocation segments.");
      const correction=await queryOne<{id:string}>(`INSERT INTO inventory_order_quantity_corrections
          (request_id,seller_key,order_id,order_line_sku_id,sku,previous_quantity,corrected_quantity,
           released_quantity,source_order_revision,available_at,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id::text AS id`,
        [input.requestId,input.sellerKey,target.orderId,input.skuId,sku,line.previousQuantity,line.currentQuantity,
          expected.reduce((sum,value)=>sum+value.quantity,0),input.sourceOrderRevision,input.availableAt,asJson(input.evidence)],db);
      if(!correction)throw new Error("Failed to record quantity correction.");
      await execute(`INSERT INTO inventory_order_quantity_correction_allocations
          (correction_id,source_supply_key,receipt_id,quantity)
        SELECT $1,x."supplyKey",x."receiptId",x.quantity FROM jsonb_to_recordset($2::jsonb)
          AS x("supplyKey" text,"receiptId" integer,quantity integer)`,[correction.id,asJson(expected)],db);
      await execute(`UPDATE inventory_fifo_replay_queue SET status='pending',claim_token=NULL,claim_expires_at=NULL,
        hold_reason=NULL,updated_at=NOW() WHERE seller_key=$1 AND sku=$2`,[input.sellerKey,sku],db);
      return {id:correction.id,repeated:false};
    });
  },

  async findOrderAllocation(sellerKey:string,orderNumber:string){
    return query(`WITH target_order AS (
        SELECT * FROM seller_orders WHERE seller_key=$1 AND order_number=$2
      ), identities AS (
        SELECT current_line.sku_id AS "skuId" FROM seller_order_lines current_line JOIN target_order ON target_order.id=current_line.order_id
        UNION SELECT saved.order_line_sku_id FROM inventory_fifo_lines saved JOIN target_order ON target_order.id=saved.order_id
      ) SELECT line.id::text AS id,identities."skuId",COALESCE(line.sku,CASE
        WHEN identities."skuId"~'^[1-9][0-9]{0,9}$'
          AND identities."skuId"::bigint BETWEEN 1 AND 2147483647 THEN identities."skuId"::integer END) AS sku,
      COALESCE(line.state,CASE WHEN identities."skuId"~'^[1-9][0-9]{0,9}$'
        AND identities."skuId"::bigint BETWEEN 1 AND 2147483647 THEN 'pending' ELSE 'unsupported' END) AS state,
      line.hold_reason AS "holdReason",COALESCE(line.ordered_quantity,current_line.ordered_quantity,0)::int AS "orderedQuantity",
      COALESCE(current_line.ordered_quantity,0)::int AS "currentOrderedQuantity",
      COALESCE(line.matched_quantity,0)::int AS "matchedQuantity",
      COALESCE(line.unmatched_quantity,current_line.ordered_quantity,0)::int AS "unmatchedQuantity",
      COALESCE(line.price_known_quantity,0)::int AS "priceKnownQuantity",
      COALESCE(line.date_known_quantity,0)::int AS "dateKnownQuantity",
      line.intake_market_total::float8 AS "intakeMarketTotal",line.weighted_days_held::float8 AS "weightedDaysHeld",
      line.current_revision_id::text AS "revisionId",orders.source_revision AS "sourceOrderRevision",
      line.source_order_revision AS "allocatedSourceOrderRevision",queue.status AS "replayStatus",
      ((line.id IS NULL AND identities."skuId"~'^[1-9][0-9]{0,9}$'
          AND identities."skuId"::bigint BETWEEN 1 AND 2147483647)
        OR queue.generation IS NOT NULL OR line.source_order_revision<>orders.source_revision) AS "allocationPending",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('supplyKey',allocation.supply_key,
        'receiptId',allocation.receipt_id,'dispositionId',allocation.disposition_id::text,
        'quantityCorrectionId',allocation.quantity_correction_id::text,
        'quantity',allocation.allocated_quantity,'availableAt',allocation.available_at) ORDER BY allocation.supply_key)
        FROM inventory_fifo_revision_allocations allocation WHERE allocation.revision_id=line.current_revision_id),'[]'::jsonb) AS allocations
      FROM target_order orders CROSS JOIN identities
      LEFT JOIN seller_order_lines current_line ON current_line.order_id=orders.id AND current_line.sku_id=identities."skuId"
      LEFT JOIN inventory_fifo_lines line ON line.order_id=orders.id AND line.order_line_sku_id=identities."skuId"
      LEFT JOIN inventory_fifo_replay_queue queue ON queue.seller_key=orders.seller_key AND queue.sku=COALESCE(line.sku,CASE
        WHEN identities."skuId"~'^[1-9][0-9]{0,9}$'
          AND identities."skuId"::bigint BETWEEN 1 AND 2147483647 THEN identities."skuId"::integer END)
      ORDER BY identities."skuId"`,[sellerKey.trim(),orderNumber.trim()]);
  },

  async listLineRevisions(input:{sellerKey:string;lineId:string;afterRevision?:number;limit?:number}){
    const limit=input.limit??50;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("Revision limit must be between 1 and 100.");
    const after=input.afterRevision??0;
    if(!Number.isInteger(after)||after<0)throw new Error("After revision must be a nonnegative integer.");
    return query(`SELECT revision.id::text AS id,revision.revision_number AS "revisionNumber",
      revision.source_order_revision AS "sourceOrderRevision",revision.order_time AS "orderTime",
      revision.trigger_reason AS "triggerReason",revision.state,revision.hold_reason AS "holdReason",
      revision.ordered_quantity AS "orderedQuantity",revision.matched_quantity AS "matchedQuantity",
      revision.unmatched_quantity AS "unmatchedQuantity",revision.price_known_quantity AS "priceKnownQuantity",
      revision.date_known_quantity AS "dateKnownQuantity",revision.intake_market_total::float8 AS "intakeMarketTotal",
      revision.weighted_days_held::float8 AS "weightedDaysHeld",revision.recorded_at AS "recordedAt",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('supplyKey',allocation.supply_key,
        'receiptId',allocation.receipt_id,'dispositionId',allocation.disposition_id::text,
        'quantityCorrectionId',allocation.quantity_correction_id::text,
        'quantity',allocation.allocated_quantity,'availableAt',allocation.available_at) ORDER BY allocation.supply_key)
        FROM inventory_fifo_revision_allocations allocation WHERE allocation.revision_id=revision.id),'[]'::jsonb) AS allocations
      FROM inventory_fifo_revisions revision JOIN inventory_fifo_lines line ON line.id=revision.line_id
      WHERE line.id=$1 AND line.seller_key=$2 AND revision.revision_number>$3
      ORDER BY revision.revision_number LIMIT $4`,[input.lineId,input.sellerKey.trim(),after,limit]);
  },

  async listHolds(sellerKey:string,options:{afterSku?:number;limit?:number}={}){
    const afterSku=options.afterSku??0;const limit=options.limit??100;
    if(!Number.isInteger(afterSku)||afterSku<0||!Number.isInteger(limit)||limit<1||limit>200)
      throw new Error("FIFO hold page must use a nonnegative SKU cursor and a limit between 1 and 200.");
    const queue=await query(`SELECT seller_key AS "sellerKey",sku,status,affected_from AS "affectedFrom",
      hold_reason AS "holdReason",updated_at AS "updatedAt"
      FROM inventory_fifo_replay_queue WHERE seller_key=$1 AND sku>$2 ORDER BY sku LIMIT $3`,[sellerKey.trim(),afterSku,limit]);
    const lines=await query(`SELECT orders.order_number AS "orderNumber",line.order_line_sku_id AS "skuId",line.sku,
      line.hold_reason AS "holdReason",line.updated_at AS "updatedAt" FROM inventory_fifo_lines line
      JOIN seller_orders orders ON orders.id=line.order_id WHERE line.seller_key=$1 AND line.state='held'
        AND line.sku>$2 ORDER BY line.sku,orders.order_time,orders.order_number,line.order_line_sku_id LIMIT $3`,
      [sellerKey.trim(),afterSku,limit]);
    return {queue,lines};
  },
};


