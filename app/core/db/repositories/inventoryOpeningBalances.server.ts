import { createHash, randomUUID } from "node:crypto";
import { asJson, execute, query, queryOne, withTransaction, type Queryable } from "../database.server";
import { quantityFingerprint, supportedQuantityFingerprint, type InventoryObservationItem } from "~/features/inventory-opening-balance/domain/inventoryObservation";

type ObservationInput = {
  requestId: string; sellerKey: string; status: "complete" | "unstable";
  claimToken: string; beforeIdentityDeclarationCount: number; afterIdentityDeclarationCount: number;
  startedAt: Date; cutoffAt: Date; quantityFingerprint: string;
  supportedQuantityFingerprint: string;
  firstContentFingerprint: string; secondContentFingerprint: string;
  items: InventoryObservationItem[]; error?: string;
};

async function observationItemsEvidence(observationId: string, db?: Queryable) {
  const items=await query<{inventoryKey:string;sku:number|null;quantity:number}>(`SELECT inventory_key AS "inventoryKey",sku,quantity
    FROM inventory_complete_observation_items WHERE observation_id=$1 ORDER BY inventory_key COLLATE "C"`,[observationId],db);
  const supported=items.filter((item)=>item.sku!==null);
  return {
    itemCount:items.length,
    positiveItemCount:items.filter((item)=>item.quantity>0).length,
    totalQuantity:items.reduce((sum,item)=>sum+item.quantity,0),
    positiveSkuCount:supported.filter((item)=>item.quantity>0).length,
    supportedTotalQuantity:supported.reduce((sum,item)=>sum+item.quantity,0),
    unsupportedPositiveItemCount:items.filter((item)=>item.sku===null&&item.quantity>0).length,
    unsupportedPositiveQuantity:items.filter((item)=>item.sku===null).reduce((sum,item)=>sum+item.quantity,0),
    quantityFingerprint:createHash("sha256").update(JSON.stringify(items.map(({inventoryKey,quantity})=>[inventoryKey,quantity]))).digest("hex"),
    supportedQuantityFingerprint:createHash("sha256").update(JSON.stringify(supported
      .sort((a,b)=>(a.sku??0)-(b.sku??0)).map(({sku,quantity})=>[sku,quantity]))).digest("hex"),
  };
}

async function evidence(sellerKey: string, cutoffAt: Date, observationId: string, db?: Queryable) {
  const orders = await query<{ id: string; revision: number }>(
    `SELECT id::text AS id, source_revision AS revision FROM seller_orders
     WHERE seller_key=$1 AND order_time < $2 ORDER BY id`, [sellerKey, cutoffAt], db);
  const receipts = await query<{ receiptId: number; liveAt: Date; quantity: number }>(
    `SELECT link.receipt_id AS "receiptId", link.live_at AS "liveAt",link.planned_quantity AS quantity
     FROM inventory_publication_receipt_links link
     WHERE link.target_seller_key=$1 AND link.live_at < $2 ORDER BY link.receipt_id`,
    [sellerKey, cutoffAt], db);
  const catalog = await query<{ sku: number; productLineId: number | null; setId: number | null; productId: number | null }>(
    `SELECT item.sku, skus.product_line_id AS "productLineId", skus.set_id AS "setId",
      skus.product_id AS "productId"
     FROM inventory_complete_observation_items item
     LEFT JOIN skus ON skus.sku=item.sku
     WHERE item.observation_id=$1 AND item.sku IS NOT NULL AND item.quantity>0
     ORDER BY item.sku`, [observationId], db);
  return createHash("sha256").update(JSON.stringify({
    orders: orders.map((row) => [row.id, row.revision]),
    receipts: receipts.map((row) => [row.receiptId, row.quantity, row.liveAt.toISOString()]),
    catalog: catalog.map((row) => [row.sku, row.productLineId, row.setId, row.productId]),
  })).digest("hex");
}

export const inventoryOpeningBalancesRepository = {
  async listDifferences(input: {sellerKey:string;observationId:string;afterId?:string;limit?:number}) {
    const limit=input.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>200) throw new Error("Difference page limit must be between 1 and 200.");
    return query(`SELECT id::text AS id,inventory_key AS "inventoryKey",sku,previous_quantity AS "previousQuantity",
      observed_quantity AS "observedQuantity",quantity_delta AS "quantityDelta",status,
      acknowledgement_note AS "acknowledgementNote",acknowledged_at AS "acknowledgedAt"
      FROM inventory_observation_differences
      WHERE seller_key=$1 AND observation_id=$2 AND id>$3::bigint
      ORDER BY id LIMIT $4`,[input.sellerKey.trim(),input.observationId,input.afterId??"0",limit]);
  },

  async listApplicationDifferences(input: {
    sellerKey:string;runId:string;validationObservationId:string;afterId?:string;limit?:number;
  }) {
    const limit=input.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>200) throw new Error("Application difference page limit must be between 1 and 200.");
    return query(`SELECT difference.id::text AS id,difference.observation_id::text AS "observationId",
      difference.inventory_key AS "inventoryKey",difference.sku,
      difference.previous_quantity AS "previousQuantity",difference.observed_quantity AS "observedQuantity",
      difference.quantity_delta AS "quantityDelta",difference.status,
      difference.acknowledgement_note AS "acknowledgementNote",
      difference.acknowledged_at AS "acknowledgedAt"
      FROM inventory_opening_balance_runs run
      JOIN inventory_complete_observations validation
        ON validation.id=$3 AND validation.seller_key=run.seller_key
      JOIN inventory_complete_observations observation
        ON observation.seller_key=run.seller_key
        AND observation.cutoff_at>run.cutoff_at AND observation.cutoff_at<=validation.cutoff_at
      JOIN inventory_observation_differences difference
        ON difference.observation_id=observation.id AND difference.sku IS NOT NULL
      WHERE run.id=$1 AND run.seller_key=$2 AND difference.id>$4::bigint
      ORDER BY difference.id LIMIT $5`,
      [input.runId,input.sellerKey.trim(),input.validationObservationId,input.afterId??"0",limit]);
  },

  async listObservationItems(input: {
    sellerKey:string;observationId:string;afterInventoryKey?:string;limit?:number;unsupportedOnly?:boolean;
  }) {
    const limit=input.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>200) throw new Error("Observation item page limit must be between 1 and 200.");
    return query(`SELECT item.inventory_key AS "inventoryKey",item.identity_kind AS "identityKind",
      item.sku,item.quantity
      FROM inventory_complete_observation_items item
      JOIN inventory_complete_observations observation ON observation.id=item.observation_id
      WHERE observation.id=$1 AND observation.seller_key=$2
        AND item.inventory_key COLLATE "C">$3 COLLATE "C"
        AND (NOT $4::boolean OR item.identity_kind='unsupported')
      ORDER BY item.inventory_key COLLATE "C" LIMIT $5`,
      [input.observationId,input.sellerKey.trim(),input.afterInventoryKey??"",input.unsupportedOnly??false,limit]);
  },

  async listPreviewItems(input: {sellerKey:string;runId:string;afterSku?:number;limit?:number}) {
    const limit=input.limit??100;
    if(!Number.isInteger(limit)||limit<1||limit>200) throw new Error("Preview item page limit must be between 1 and 200.");
    return query(`SELECT item.sku,item.opening_quantity AS "openingQuantity",
      item.product_line_id AS "productLineId",item.set_id AS "setId",item.product_id AS "productId"
      FROM inventory_opening_balance_items item
      JOIN inventory_opening_balance_runs run ON run.id=item.run_id
      WHERE run.id=$1 AND run.seller_key=$2 AND item.sku>$3
      ORDER BY item.sku LIMIT $4`,[input.runId,input.sellerKey.trim(),input.afterSku??0,limit]);
  },

  async findApplicationReplay(input: {runId:string;sellerKey:string;requestId:string;expectedFingerprint:string}) {
    const run=await queryOne<any>(`SELECT run.id::text AS id,run.status,
      run.evidence_fingerprint AS "evidenceFingerprint",run.apply_request_id AS "applyRequestId",
      run.validation_observation_id::text AS "validationObservationId",
      validation.unsupported_positive_item_count AS "unsupportedPositiveItemCount",
      validation.unsupported_positive_quantity AS "unsupportedPositiveQuantity"
      FROM inventory_opening_balance_runs run
      LEFT JOIN inventory_complete_observations validation ON validation.id=run.validation_observation_id
      WHERE run.id=$1 AND run.seller_key=$2`,[input.runId,input.sellerKey.trim()]);
    if(!run) throw new Error("Opening balance preview was not found.");
    if(run.status!=="applied") {
      if(run.status!=="previewed" || run.evidenceFingerprint!==input.expectedFingerprint) {
        throw new Error("Opening balance preview is blocked or stale.");
      }
      return null;
    }
    if(run.applyRequestId!==input.requestId.trim() || run.evidenceFingerprint!==input.expectedFingerprint) {
      throw new Error("Opening balance application evidence conflicts.");
    }
    return run;
  },

  async beginObservationCapture(input: { requestId: string; sellerKey: string; purposeEvidence?: Record<string,unknown> }) {
    return withTransaction(async (db) => {
      const purposeEvidence=input.purposeEvidence??{kind:"opening_observation"};
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opening-capture:${input.requestId}`]);
      const existing = await queryOne<{
        sellerKey: string; status: string; claimExpiresAt: Date | null; observationId: string | null;
        purposeMatches: boolean;
      }>(`SELECT seller_key AS "sellerKey",status,claim_expires_at AS "claimExpiresAt",
          observation_id::text AS "observationId",purpose_evidence=$2::jsonb AS "purposeMatches"
         FROM inventory_complete_observation_requests WHERE request_id=$1 FOR UPDATE`,
        [input.requestId,asJson(purposeEvidence)],db);
      if (existing?.sellerKey !== undefined && existing.sellerKey !== input.sellerKey) {
        throw new Error("Observation request ID was reused for a different seller.");
      }
      if(existing && !existing.purposeMatches) {
        throw new Error("Observation request ID was reused for a different purpose.");
      }
      if (existing?.status === "complete" && existing.observationId) {
        const observation = await queryOne<any>(
          `SELECT id::text AS id,seller_key AS "sellerKey",status,
            quantity_fingerprint AS "quantityFingerprint",supported_quantity_fingerprint AS "supportedQuantityFingerprint",
            item_count AS "itemCount",positive_item_count AS "positiveItemCount",total_quantity AS "observedTotalQuantity",
            supported_positive_sku_count AS "positiveSkuCount",supported_total_quantity AS "totalQuantity",
            unsupported_positive_item_count AS "unsupportedPositiveItemCount",
            unsupported_positive_quantity AS "unsupportedPositiveQuantity",
            cutoff_at AS "cutoffAt"
           FROM inventory_complete_observations WHERE id=$1`,[existing.observationId],db);
        if (!observation) throw new Error("Completed inventory observation evidence is missing.");
        return { state: "complete" as const, observation };
      }
      if (existing?.status === "capturing" && existing.claimExpiresAt && existing.claimExpiresAt.getTime() > Date.now()) {
        throw new Error("This inventory observation capture is already in progress.");
      }
      const claimToken=randomUUID();
      if (existing) {
        await execute(`UPDATE inventory_complete_observation_requests
          SET status='capturing',claim_token=$2,claim_expires_at=NOW()+INTERVAL '3 minutes',
            observation_id=NULL,error=NULL,updated_at=NOW() WHERE request_id=$1`,[input.requestId,claimToken],db);
      } else {
        await execute(`INSERT INTO inventory_complete_observation_requests
          (request_id,seller_key,purpose_evidence,status,claim_token,claim_expires_at)
          VALUES ($1,$2,$3::jsonb,'capturing',$4,NOW()+INTERVAL '3 minutes')`,
          [input.requestId,input.sellerKey,asJson(purposeEvidence),claimToken],db);
      }
      return { state: "claimed" as const, claimToken };
    });
  },

  async failObservationCapture(requestId: string, claimToken: string, error: string) {
    await execute(`UPDATE inventory_complete_observation_requests
      SET status='failed',claim_token=NULL,claim_expires_at=NULL,error=$3,updated_at=NOW()
      WHERE request_id=$1 AND status='capturing' AND claim_token=$2`,[requestId,claimToken,error.slice(0,500)]);
  },

  async recordObservation(input: ObservationInput) {
    return withTransaction(async (db) => {
      const totalQuantity=input.items.reduce((sum,item)=>sum+item.quantity,0);
      const supportedItems=input.items.filter((item)=>item.sku!==null);
      const supportedTotalQuantity=supportedItems.reduce((sum,item)=>sum+item.quantity,0);
      const unsupportedPositiveItems=input.items.filter((item)=>item.sku===null&&item.quantity>0);
      const inventoryKeys=new Set(input.items.map((item)=>item.inventoryKey));
      const numericSkus=new Set(supportedItems.map((item)=>item.sku));
      if (!input.requestId.trim() || !input.sellerKey.trim() || input.beforeIdentityDeclarationCount < 2 ||
          input.afterIdentityDeclarationCount < 2 || input.items.length > 50_000 ||
          inventoryKeys.size!==input.items.length || numericSkus.size!==supportedItems.length ||
          input.items.some((item)=>!/^[\x21-\x7e]{1,100}$/.test(item.inventoryKey) ||
            !["standard_sku","unsupported"].includes(item.identityKind) ||
            (item.sku===null)!==(item.identityKind==="unsupported") ||
            (item.sku!==null&&(!Number.isInteger(item.sku)||item.sku<=0||item.sku>2_147_483_647))||
            !Number.isInteger(item.quantity)||item.quantity<0||item.quantity>2_147_483_647) ||
          !Number.isSafeInteger(totalQuantity)||totalQuantity>2_147_483_647 ||
          !Number.isSafeInteger(supportedTotalQuantity)||supportedTotalQuantity>2_147_483_647 ||
          quantityFingerprint(input.items)!==input.quantityFingerprint ||
          supportedQuantityFingerprint(input.items)!==input.supportedQuantityFingerprint) {
        throw new Error("Inventory observation evidence is invalid.");
      }
      const request=await queryOne<{sellerKey:string;status:string;claimToken:string|null}>(
        `SELECT seller_key AS "sellerKey",status,claim_token AS "claimToken"
         FROM inventory_complete_observation_requests WHERE request_id=$1 FOR UPDATE`,[input.requestId],db);
      if (!request || request.sellerKey !== input.sellerKey || request.status !== "capturing" || request.claimToken !== input.claimToken) {
        throw new Error("Inventory observation capture claim was lost.");
      }
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opening-observation:${input.sellerKey}`]);
      if (input.startedAt.getTime() > input.cutoffAt.getTime()) throw new Error("Inventory observation cutoff precedes its start.");
      const positive = input.items.filter((item) => item.quantity > 0);
      const latestObservation = await queryOne<{ cutoffAt: Date }>(
        `SELECT cutoff_at AS "cutoffAt" FROM inventory_complete_observations
         WHERE seller_key=$1 ORDER BY cutoff_at DESC,id DESC LIMIT 1`,[input.sellerKey],db);
      if (latestObservation && latestObservation.cutoffAt.getTime() >= input.cutoffAt.getTime()) {
        throw new Error("Inventory observations must advance the seller cutoff.");
      }
      const previous = await queryOne<{ id: string; cutoffAt: Date }>(
        `SELECT id::text AS id,cutoff_at AS "cutoffAt" FROM inventory_complete_observations
         WHERE seller_key=$1 AND status='complete' ORDER BY cutoff_at DESC,id DESC LIMIT 1`,
        [input.sellerKey],db);
      const row = await queryOne<{ id: string }>(
        `INSERT INTO inventory_complete_observations (
          request_id,seller_key,source,status,quantity_semantics,started_at,cutoff_at,
          quantity_fingerprint,supported_quantity_fingerprint,first_content_fingerprint,second_content_fingerprint,
          item_count,positive_item_count,total_quantity,supported_positive_sku_count,supported_total_quantity,
          unsupported_positive_item_count,unsupported_positive_quantity,identity_evidence,error
        ) VALUES ($1,$2,'seller_portal_live_export',$3,'sellable_excludes_reserved',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
        RETURNING id::text AS id`,
        [input.requestId,input.sellerKey,input.status,input.startedAt,input.cutoffAt,
          input.quantityFingerprint,input.supportedQuantityFingerprint,input.firstContentFingerprint,input.secondContentFingerprint,
          input.items.length,positive.length,totalQuantity,supportedItems.filter((item)=>item.quantity>0).length,
          supportedTotalQuantity,unsupportedPositiveItems.length,
          unsupportedPositiveItems.reduce((sum,item)=>sum+item.quantity,0),
          asJson({
            sellerKey: input.sellerKey, checkedBeforeAndAfter: true,
            beforeDeclarationCount: input.beforeIdentityDeclarationCount,
            afterDeclarationCount: input.afterIdentityDeclarationCount,
          }),input.error??null],db);
      if (!row) throw new Error("Failed to record inventory observation.");
      await execute(
        `INSERT INTO inventory_complete_observation_items (observation_id,inventory_key,identity_kind,sku,quantity)
         SELECT $1,x."inventoryKey",x."identityKind",x.sku,x.quantity
         FROM jsonb_to_recordset($2::jsonb) AS x("inventoryKey" text,"identityKind" text,sku integer,quantity integer)`,
        [row.id,asJson(input.items.map(({inventoryKey,identityKind,sku,quantity})=>({inventoryKey,identityKind,sku,quantity})))],db);
      if (previous && input.status === "complete") await execute(
        `INSERT INTO inventory_observation_differences
          (seller_key,previous_observation_id,observation_id,inventory_key,sku,quantity_delta,previous_quantity,observed_quantity)
         SELECT $1,$2,$3,COALESCE(old.inventory_key,current.inventory_key),COALESCE(old.sku,current.sku),
           COALESCE(current.quantity,0)-COALESCE(old.quantity,0),
           COALESCE(old.quantity,0),COALESCE(current.quantity,0)
         FROM (SELECT inventory_key,sku,quantity FROM inventory_complete_observation_items WHERE observation_id=$2) old
         FULL JOIN (SELECT inventory_key,sku,quantity FROM inventory_complete_observation_items WHERE observation_id=$3) current
           USING (inventory_key)
         WHERE COALESCE(current.quantity,0)<>COALESCE(old.quantity,0)`,
        [input.sellerKey,previous.id,row.id],db);
      await execute(`DELETE FROM inventory_complete_observation_items item
        WHERE item.observation_id IN (
          SELECT old.id FROM inventory_complete_observations old
          WHERE old.seller_key=$1
            AND old.id NOT IN (
              SELECT recent.id FROM inventory_complete_observations recent
              WHERE recent.seller_key=$1 ORDER BY recent.cutoff_at DESC,recent.id DESC LIMIT 3
            )
            AND NOT EXISTS (
              SELECT 1 FROM inventory_opening_balance_runs run
              WHERE run.observation_id=old.id OR run.validation_observation_id=old.id
            )
            AND old.id <> COALESCE((
              SELECT latest.id FROM inventory_complete_observations latest
              WHERE latest.seller_key=$1 AND latest.status='complete'
              ORDER BY latest.cutoff_at DESC,latest.id DESC LIMIT 1
            ),-1)
        )`,[input.sellerKey],db);
      await execute(`UPDATE inventory_complete_observation_requests
        SET status='complete',claim_token=NULL,claim_expires_at=NULL,observation_id=$2,updated_at=NOW()
        WHERE request_id=$1`,[input.requestId,row.id],db);
      return {
        id: row.id, sellerKey: input.sellerKey, status: input.status,
        quantityFingerprint: input.quantityFingerprint,supportedQuantityFingerprint:input.supportedQuantityFingerprint,
        itemCount:input.items.length,positiveItemCount:positive.length,observedTotalQuantity:totalQuantity,
        positiveSkuCount:supportedItems.filter((item)=>item.quantity>0).length,totalQuantity:supportedTotalQuantity,
        unsupportedPositiveItemCount:unsupportedPositiveItems.length,
        unsupportedPositiveQuantity:unsupportedPositiveItems.reduce((sum,item)=>sum+item.quantity,0),
      };
    });
  },

  async preview(input: { requestId: string; sellerKey: string; observationId: string }) {
    return withTransaction(async (db) => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opening:${input.sellerKey}`]);
      const existing = await queryOne<any>(
        `SELECT run.id::text AS id,run.seller_key AS "sellerKey",run.observation_id::text AS "observationId",
          run.cutoff_at AS "cutoffAt",run.status,run.evidence_fingerprint AS "evidenceFingerprint",run.unresolved,run.limitations,
          observation.item_count AS "itemCount",observation.positive_item_count AS "positiveItemCount",
          observation.total_quantity AS "observedTotalQuantity",
          observation.supported_positive_sku_count AS "positiveSkuCount",
          observation.supported_total_quantity AS "totalQuantity",
          observation.unsupported_positive_item_count AS "unsupportedPositiveItemCount",
          observation.unsupported_positive_quantity AS "unsupportedPositiveQuantity"
         FROM inventory_opening_balance_runs run
         JOIN inventory_complete_observations observation ON observation.id=run.observation_id
         WHERE run.request_id=$1`,[input.requestId],db);
      if (existing) {
        if (existing.sellerKey !== input.sellerKey || existing.observationId !== input.observationId) {
          throw new Error("Opening preview request ID was reused with different inputs.");
        }
        return existing;
      }
      const observation = await queryOne<any>(
        `SELECT id::text AS id,seller_key AS "sellerKey",status,cutoff_at AS "cutoffAt",
          started_at AS "startedAt", quantity_fingerprint AS "quantityFingerprint",
          supported_quantity_fingerprint AS "supportedQuantityFingerprint",
          item_count AS "itemCount",positive_item_count AS "positiveItemCount",total_quantity AS "observedTotalQuantity",
          supported_positive_sku_count AS "positiveSkuCount",supported_total_quantity AS "totalQuantity",
          unsupported_positive_item_count AS "unsupportedPositiveItemCount",
          unsupported_positive_quantity AS "unsupportedPositiveQuantity"
         FROM inventory_complete_observations WHERE id=$1`,
        [input.observationId],db);
      if (!observation || observation.sellerKey !== input.sellerKey) throw new Error("Complete inventory observation does not match seller.");
      const retainedEvidence=await observationItemsEvidence(observation.id,db);
      if(retainedEvidence.itemCount!==observation.itemCount ||
          retainedEvidence.positiveItemCount!==observation.positiveItemCount ||
          retainedEvidence.totalQuantity!==observation.observedTotalQuantity ||
          retainedEvidence.positiveSkuCount!==observation.positiveSkuCount ||
          retainedEvidence.supportedTotalQuantity!==observation.totalQuantity ||
          retainedEvidence.unsupportedPositiveItemCount!==observation.unsupportedPositiveItemCount ||
          retainedEvidence.unsupportedPositiveQuantity!==observation.unsupportedPositiveQuantity ||
          retainedEvidence.quantityFingerprint!==observation.quantityFingerprint ||
          retainedEvidence.supportedQuantityFingerprint!==observation.supportedQuantityFingerprint) {
        throw new Error("Complete inventory observation item evidence is unavailable or inconsistent.");
      }
      await db.query(
        `SELECT skus.sku FROM skus
         JOIN inventory_complete_observation_items item ON item.sku=skus.sku
         WHERE item.observation_id=$1 AND item.quantity>0 FOR SHARE OF skus`,[input.observationId]);
      const coverage = await queryOne<any>(
        `SELECT id::text AS id,finished_at AS "finishedAt",observed_from AS "observedFrom",
          observed_through AS "observedThrough",orders_observed AS "ordersObserved",
          details_recorded AS "detailsRecorded" FROM seller_order_sync_runs
         WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND finished_at >= $2
         ORDER BY finished_at ASC LIMIT 1`,[input.sellerKey,observation.cutoffAt],db);
      const missing = await query<{ sku: number }>(
        `SELECT item.sku FROM inventory_complete_observation_items item
         LEFT JOIN skus ON skus.sku=item.sku
         WHERE item.observation_id=$1 AND item.sku IS NOT NULL AND item.quantity>0
           AND (skus.sku IS NULL OR skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL)`,[input.observationId],db);
      const intervalOrders = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM seller_orders
         WHERE seller_key=$1 AND order_time >= $2 AND order_time < $3`,
        [input.sellerKey,observation.startedAt,observation.cutoffAt],db);
      const intervalPublications = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM inventory_publication_receipt_links
         WHERE target_seller_key=$1 AND live_at >= $2 AND live_at < $3`,
        [input.sellerKey,observation.startedAt,observation.cutoffAt],db);
      const unresolvedDifferences = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM inventory_observation_differences
         WHERE observation_id=$1 AND status='unresolved' AND sku IS NOT NULL`, [input.observationId], db);
      const unsupportedDifferences = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM inventory_observation_differences
         WHERE observation_id=$1 AND status='unresolved' AND sku IS NULL`, [input.observationId], db);
      const appliedOpening = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM inventory_opening_balance_runs
         WHERE seller_key=$1 AND status='applied'`,[input.sellerKey],db);
      const unresolved = [
        ...(observation.status !== "complete" ? ["Inventory quantities changed during observation."] : []),
        ...(!coverage ? ["Complete seller order coverage through the cutoff is required."] : []),
        ...(missing.length ? [`${missing.length} positive inventory SKUs lack catalog identity.`] : []),
        ...((intervalOrders?.count ?? 0) > 0 ? ["An order occurred during the inventory observation interval."] : []),
        ...((intervalPublications?.count ?? 0) > 0 ? ["A publication became live during the inventory observation interval."] : []),
        ...((unresolvedDifferences?.count ?? 0) > 0 ? [`${unresolvedDifferences?.count} inventory changes require review.`] : []),
        ...((appliedOpening?.count ?? 0) > 0 ? ["This seller already has an applied opening balance."] : []),
      ];
      const limitations = [
        ...(observation.unsupportedPositiveItemCount>0 ?
          [`${observation.unsupportedPositiveItemCount} unsupported positive inventory items (${observation.unsupportedPositiveQuantity} units) are preserved as evidence and excluded from this standard-SKU opening balance.`] : []),
        ...((unsupportedDifferences?.count??0)>0 ?
          [`${unsupportedDifferences?.count} unsupported inventory identity changes remain unavailable to FIFO.`] : []),
      ];
      const sourceEvidence = await evidence(input.sellerKey, observation.cutoffAt, input.observationId, db);
      const fingerprint = createHash("sha256").update(JSON.stringify({
        observation: observation.supportedQuantityFingerprint, orderCoverage: coverage?.id ?? null, sourceEvidence,
      })).digest("hex");
      const run = await queryOne<{ id: string; status: string }>(
        `INSERT INTO inventory_opening_balance_runs
          (request_id,seller_key,observation_id,order_coverage_run_id,order_coverage_evidence,cutoff_at,status,evidence_fingerprint,unresolved,limitations)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING id::text AS id,status`,
        [input.requestId,input.sellerKey,input.observationId,coverage?.id??null,asJson(coverage),
          observation.cutoffAt,unresolved.length?"blocked":"previewed",fingerprint,asJson(unresolved),asJson(limitations)],db);
      if (!run) throw new Error("Failed to create opening preview.");
      await execute(
        `INSERT INTO inventory_opening_balance_items
          (run_id,sku,opening_quantity,product_line_id,set_id,product_id)
         SELECT $1,item.sku,item.quantity,
           CASE WHEN skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL THEN NULL ELSE skus.product_line_id END,
           CASE WHEN skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL THEN NULL ELSE skus.set_id END,
           CASE WHEN skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL THEN NULL ELSE skus.product_id END
         FROM inventory_complete_observation_items item
         LEFT JOIN skus ON skus.sku=item.sku
         WHERE item.observation_id=$2 AND item.sku IS NOT NULL AND item.quantity>0`,
        [run.id,input.observationId],db);
      return {
        ...run, cutoffAt: observation.cutoffAt, evidenceFingerprint: fingerprint, unresolved,limitations,
        itemCount:observation.itemCount,positiveItemCount:observation.positiveItemCount,
        observedTotalQuantity:observation.observedTotalQuantity,
        positiveSkuCount: observation.positiveSkuCount,totalQuantity: observation.totalQuantity,
        unsupportedPositiveItemCount:observation.unsupportedPositiveItemCount,
        unsupportedPositiveQuantity:observation.unsupportedPositiveQuantity,
      };
    });
  },

  async apply(input: {
    runId: string; expectedFingerprint: string; sellerKey: string;
    requestId: string; validationObservationId: string;
  }) {
    return withTransaction(async (db) => {
      const run = await queryOne<any>(
        `SELECT run.id::text AS id,run.seller_key AS "sellerKey",run.cutoff_at AS "cutoffAt",run.status,
          run.evidence_fingerprint AS "evidenceFingerprint",run.observation_id::text AS "observationId",
          run.apply_request_id AS "applyRequestId",
          run.validation_observation_id::text AS "validationObservationId",
          validation.unsupported_positive_item_count AS "unsupportedPositiveItemCount",
          validation.unsupported_positive_quantity AS "unsupportedPositiveQuantity"
         FROM inventory_opening_balance_runs run
         LEFT JOIN inventory_complete_observations validation ON validation.id=run.validation_observation_id
         WHERE run.id=$1 AND run.seller_key=$2 FOR UPDATE OF run`,[input.runId,input.sellerKey.trim()],db);
      if (!run) throw new Error("Opening balance preview was not found.");
      if (run.status === "applied") {
        if (run.evidenceFingerprint !== input.expectedFingerprint || run.applyRequestId !== input.requestId.trim()) {
          throw new Error("Opening balance application evidence conflicts.");
        }
        return run;
      }
      if (!input.requestId.trim() || run.status !== "previewed" || run.evidenceFingerprint !== input.expectedFingerprint) {
        throw new Error("Opening balance preview is blocked or stale.");
      }
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opening:${run.sellerKey}`]);
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`opening-observation:${run.sellerKey}`]);
      const validation=await queryOne<any>(
        `SELECT validation.id::text AS id,validation.seller_key AS "sellerKey",validation.status,
          validation.started_at AS "startedAt",validation.cutoff_at AS "cutoffAt",
          validation.quantity_fingerprint AS "quantityFingerprint",
          validation.supported_quantity_fingerprint AS "supportedQuantityFingerprint",
          validation.item_count AS "itemCount",validation.positive_item_count AS "positiveItemCount",
          validation.total_quantity AS "observedTotalQuantity",
          validation.supported_positive_sku_count AS "positiveSkuCount",
          validation.supported_total_quantity AS "totalQuantity",
          validation.unsupported_positive_item_count AS "unsupportedPositiveItemCount",
          validation.unsupported_positive_quantity AS "unsupportedPositiveQuantity",
          validation.cutoff_at >= NOW()-INTERVAL '5 minutes' AS "isFresh",
          original.supported_quantity_fingerprint AS "originalSupportedQuantityFingerprint"
         FROM inventory_complete_observations validation
         JOIN inventory_complete_observations original ON original.id=$2
         WHERE validation.id=$1`,[input.validationObservationId,run.observationId],db);
      if(!validation || validation.sellerKey!==run.sellerKey || validation.status!=="complete" ||
          validation.supportedQuantityFingerprint!==validation.originalSupportedQuantityFingerprint ||
          validation.cutoffAt.getTime()<=run.cutoffAt.getTime() || !validation.isFresh) {
        throw new Error("Current complete seller inventory does not match the opening preview.");
      }
      const validationItems=await observationItemsEvidence(validation.id,db);
      if(validationItems.itemCount!==validation.itemCount ||
          validationItems.positiveItemCount!==validation.positiveItemCount ||
          validationItems.totalQuantity!==validation.observedTotalQuantity ||
          validationItems.positiveSkuCount!==validation.positiveSkuCount ||
          validationItems.supportedTotalQuantity!==validation.totalQuantity ||
          validationItems.unsupportedPositiveItemCount!==validation.unsupportedPositiveItemCount ||
          validationItems.unsupportedPositiveQuantity!==validation.unsupportedPositiveQuantity ||
          validationItems.quantityFingerprint!==validation.quantityFingerprint ||
          validationItems.supportedQuantityFingerprint!==validation.supportedQuantityFingerprint) {
        throw new Error("Current inventory item evidence is unavailable or inconsistent.");
      }
      const latest=await queryOne<{id:string}>(`SELECT id::text AS id FROM inventory_complete_observations
        WHERE seller_key=$1 ORDER BY cutoff_at DESC,id DESC LIMIT 1`,[run.sellerKey],db);
      if(latest?.id!==validation.id) throw new Error("A newer seller inventory observation must be reconciled first.");
      const validationDifferences=await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count
        FROM inventory_observation_differences difference
        JOIN inventory_complete_observations observation ON observation.id=difference.observation_id
        WHERE observation.seller_key=$1 AND observation.cutoff_at>$2 AND observation.cutoff_at<=$3
          AND difference.status='unresolved' AND difference.sku IS NOT NULL`,[run.sellerKey,run.cutoffAt,validation.cutoffAt],db);
      if((validationDifferences?.count??0)>0) throw new Error("Current seller inventory differences must be acknowledged before apply.");
      const validationCoverage=await queryOne<any>(`SELECT id::text AS id,finished_at AS "finishedAt",
          observed_from AS "observedFrom",observed_through AS "observedThrough",
          orders_observed AS "ordersObserved",details_recorded AS "detailsRecorded"
        FROM seller_order_sync_runs
        WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND finished_at >= $2
        ORDER BY finished_at ASC LIMIT 1`,[run.sellerKey,validation.cutoffAt],db);
      if(!validationCoverage) throw new Error("Complete seller order coverage after inventory revalidation is required.");
      const validationIntervalOrders=await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM seller_orders
        WHERE seller_key=$1 AND order_time >= $2 AND order_time < $3`,
        [run.sellerKey,validation.startedAt,validation.cutoffAt],db);
      const validationIntervalPublications=await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count
        FROM inventory_publication_receipt_links
        WHERE target_seller_key=$1 AND live_at >= $2 AND live_at < $3`,
        [run.sellerKey,validation.startedAt,validation.cutoffAt],db);
      if((validationIntervalOrders?.count??0)>0 || (validationIntervalPublications?.count??0)>0) {
        throw new Error("Seller inventory changed during apply revalidation.");
      }
      const currentEvidence = await evidence(run.sellerKey, run.cutoffAt, run.observationId, db);
      const coverage = await queryOne<{ id: string }>(`SELECT order_coverage_run_id::text AS id FROM inventory_opening_balance_runs WHERE id=$1`,[input.runId],db);
      const observation = await queryOne<{ fp: string }>(`SELECT supported_quantity_fingerprint AS fp FROM inventory_complete_observations WHERE id=$1`,[run.observationId],db);
      const recomputed = createHash("sha256").update(JSON.stringify({ observation: observation?.fp, orderCoverage: coverage?.id, sourceEvidence: currentEvidence })).digest("hex");
      if (recomputed !== input.expectedFingerprint) throw new Error("Opening balance evidence changed; create a new preview.");
      const positive=await queryOne<{count:number}>(`SELECT COUNT(*)::int AS count FROM inventory_opening_balance_items
        WHERE run_id=$1 AND opening_quantity>0`,[input.runId],db);
      const expectedCount=positive?.count??0;
      const mutations=await execute(`INSERT INTO inventory_pending_mutations
          (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
        SELECT 'opening:'||$1::text||':'||item.sku::text,'opening',item.sku,item.opening_quantity,
          item.product_line_id,item.set_id,item.product_id,item.opening_quantity,item.opening_quantity
        FROM inventory_opening_balance_items item
        WHERE item.run_id=$1::bigint AND item.opening_quantity>0
          AND item.product_line_id IS NOT NULL AND item.set_id IS NOT NULL AND item.product_id IS NOT NULL`,[input.runId],db);
      if(mutations!==expectedCount) throw new Error("Opening balance catalog evidence is incomplete.");
      const receipts=await execute(`WITH inserted AS (INSERT INTO inventory_receipts
          (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,intake_at,
           market_value,market_observed_at,market_calculated_at,market_provenance,source_evidence,
           receipt_kind,opening_balance_run_id,fifo_precedence)
          SELECT 'opening:'||$1::text||':'||item.sku::text,item.sku,item.opening_quantity,
            item.product_line_id,item.set_id,item.product_id,$2,NULL,NULL,NULL,NULL,
            'opening_balance_unknown',jsonb_build_object('observationId',$3::bigint,'cutoffAt',$4::timestamptz),
            'opening_balance',$1::bigint,0
          FROM inventory_opening_balance_items item
          WHERE item.run_id=$1::bigint AND item.opening_quantity>0
            AND item.product_line_id IS NOT NULL AND item.set_id IS NOT NULL AND item.product_id IS NOT NULL
          RETURNING receipt_id,sku)
        UPDATE inventory_opening_balance_items item SET receipt_id=inserted.receipt_id
        FROM inserted WHERE item.run_id=$1::bigint AND item.sku=inserted.sku`,
        [input.runId,run.sellerKey,run.observationId,run.cutoffAt],db);
      if(receipts!==expectedCount) throw new Error("Opening balance receipt conservation failed.");
      await execute(`UPDATE inventory_opening_balance_runs SET status='applied',apply_request_id=$2,
        validation_observation_id=$3,validation_order_coverage_evidence=$4::jsonb,applied_at=NOW()
        WHERE id=$1`,[input.runId,input.requestId.trim(),validation.id,asJson(validationCoverage)],db);
      return {
        ...run,status:"applied",validationObservationId:validation.id,
        unsupportedPositiveItemCount:validation.unsupportedPositiveItemCount,
        unsupportedPositiveQuantity:validation.unsupportedPositiveQuantity,
      };
    });
  },

  async acknowledgeDifference(input: { requestId: string; id: string; sellerKey: string; note: string }) {
    if (!input.requestId.trim() || !input.note.trim()) throw new Error("An acknowledgement request ID and note are required.");
    return withTransaction(async (db) => {
      const replay=await queryOne<{id:string;sellerKey:string;note:string|null}>(
        `SELECT id::text AS id,seller_key AS "sellerKey",acknowledgement_note AS note
         FROM inventory_observation_differences WHERE acknowledgement_request_id=$1 FOR UPDATE`,[input.requestId],db);
      if(replay){
        if(replay.id!==input.id || replay.sellerKey!==input.sellerKey.trim() || replay.note!==input.note.trim()) {
          throw new Error("Inventory difference acknowledgement request conflicts.");
        }
        return {id:replay.id};
      }
      const existing=await queryOne<{id:string;sellerKey:string;status:string}>(
        `SELECT id::text AS id,seller_key AS "sellerKey",status
         FROM inventory_observation_differences WHERE id=$1 AND seller_key=$2 FOR UPDATE`,[input.id,input.sellerKey.trim()],db);
      if (!existing) {
        throw new Error("Unresolved inventory difference was not found for seller.");
      }
      const row=await queryOne<{id:string}>(`UPDATE inventory_observation_differences
        SET status='acknowledged',acknowledgement_request_id=$2,acknowledgement_note=$3,acknowledged_at=NOW()
        WHERE id=$1 AND status='unresolved' RETURNING id::text AS id`,[input.id,input.requestId.trim(),input.note.trim()],db);
      if (!row) throw new Error("Unresolved inventory difference was not found.");
      return row;
    });
  },
};
