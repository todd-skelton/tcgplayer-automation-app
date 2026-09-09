import { asJson, execute, getPool, query, queryOne, type Queryable } from "../database.server";
import type { ReinvestmentTurnaroundReport } from "~/features/inventory-strategy/types/reinvestmentTurnaround";
import type { ReinvestmentOrderCoverage } from "~/features/inventory-strategy/types/reinvestmentTurnaround";

const COMPLETE_SOURCE_LIMIT = 10_000;

export interface ReinvestmentPurchaseSourceRow {
  purchaseReference: string;
  currency: string;
  totalAmountCents: number;
  costProvenance: "actual" | "estimated";
  purchasedAt: string | null;
  costSourceIdentity: string;
  receiptId: number;
  productLineId: number;
  allocatedAmountCents: number;
  originalQuantity: number;
  publicationItemId: string | null;
  plannedQuantity: number | null;
  liveAt: Date | null;
  publicationState: string | null;
  publicationIdentity: unknown;
}

export interface ReinvestmentFundingSourceRow {
  adjustmentReference: string;
  currency: string;
  adjustmentType: "opening_cash" | "external_contribution" | "withdrawal" | "reserve" | "reserve_release" | "purchase_funding";
  amountCents: number;
  provenance: "actual" | "estimated";
  effectiveAt: string;
  purchaseReference: string | null;
  sourceIdentity: string;
}

export interface ReinvestmentSourceEvidence {
  purchaseRows: ReinvestmentPurchaseSourceRow[];
  fundingRows: ReinvestmentFundingSourceRow[];
  unknownCostReceiptCount: number;
  unknownCostReceipts: Array<{
    receiptId:number;
    productLineId:number;
    identity:unknown;
    occurredAt:Date|null;
  }>;
  orderCoverage: ReinvestmentOrderCoverage | null;
}

function assertComplete<T>(rows:T[], source:string):T[] {
  if (rows.length>COMPLETE_SOURCE_LIMIT) throw new Error(`${source} exceeds the 10,000-row complete-evidence fence.`);
  return rows;
}

export const inventoryReinvestmentRepository = {
  async findSourceEvidence(sellerKey:string,executor?:Queryable):Promise<ReinvestmentSourceEvidence> {
    const seller=sellerKey.trim();
    const loadPurchases=()=>query<ReinvestmentPurchaseSourceRow>(`WITH current_cost AS (
          SELECT DISTINCT ON (entry.series_id) entry.id,entry.series_id,entry.total_amount_cents,entry.provenance,
            entry.purchased_at,entry.request_fingerprint
          FROM inventory_purchase_cost_entries entry ORDER BY entry.series_id,entry.sequence DESC
        ) SELECT series.purchase_reference AS "purchaseReference",series.currency,
          current.total_amount_cents::float8 AS "totalAmountCents",current.provenance AS "costProvenance",
          current.purchased_at::text AS "purchasedAt",current.request_fingerprint AS "costSourceIdentity",
          allocation.receipt_id AS "receiptId",receipt.product_line_id AS "productLineId",
          allocation.allocated_amount_cents::float8 AS "allocatedAmountCents",
          receipt.original_quantity AS "originalQuantity",link.publication_item_id::text AS "publicationItemId",
          link.planned_quantity AS "plannedQuantity",link.live_at AS "liveAt",item.status AS "publicationState",
          CASE WHEN link.publication_item_id IS NULL THEN NULL ELSE jsonb_build_object(
            'publicationItemId',link.publication_item_id,'state',item.status,'plannedQuantity',link.planned_quantity,
            'liveAt',link.live_at,'confirmation',link.confirmation_evidence) END AS "publicationIdentity"
        FROM inventory_purchase_cost_series series
        JOIN current_cost current ON current.series_id=series.id
        JOIN inventory_purchase_cost_allocations allocation ON allocation.entry_id=current.id
        JOIN inventory_receipts receipt ON receipt.receipt_id=allocation.receipt_id
        LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
          AND link.target_seller_key=series.seller_key
        LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
        WHERE series.seller_key=$1 AND receipt.receipt_kind='received'
          AND NOT EXISTS (
            SELECT 1 FROM inventory_purchase_cost_allocations invalid_allocation
            JOIN inventory_receipts invalid_receipt ON invalid_receipt.receipt_id=invalid_allocation.receipt_id
            WHERE invalid_allocation.entry_id=current.id AND invalid_receipt.receipt_kind<>'received'
          )
        ORDER BY series.currency,current.purchased_at NULLS LAST,series.purchase_reference,allocation.receipt_id
        LIMIT 10001`,[seller],executor);
    const loadFunding=()=>query<ReinvestmentFundingSourceRow>(`WITH current_funding AS (
          SELECT DISTINCT ON (entry.series_id) entry.*
          FROM inventory_funding_entries entry ORDER BY entry.series_id,entry.sequence DESC
        ) SELECT series.adjustment_reference AS "adjustmentReference",series.currency,
          current.adjustment_type AS "adjustmentType",current.amount_cents::float8 AS "amountCents",
          current.provenance,current.effective_at::text AS "effectiveAt",
          current.purchase_reference AS "purchaseReference",current.request_fingerprint AS "sourceIdentity"
        FROM inventory_funding_series series JOIN current_funding current ON current.series_id=series.id
        WHERE series.seller_key=$1
        ORDER BY series.currency,current.effective_at,series.adjustment_reference LIMIT 10001`,[seller],executor);
    const loadUnknownCost=()=>query<{receiptId:number;productLineId:number;identity:unknown;occurredAt:Date|null}>(`WITH current_cost AS (
          SELECT DISTINCT ON (entry.series_id) entry.id,entry.series_id
          FROM inventory_purchase_cost_entries entry ORDER BY entry.series_id,entry.sequence DESC
        ), costed AS (
          SELECT allocation.receipt_id FROM inventory_purchase_cost_series series
          JOIN current_cost current ON current.series_id=series.id
          JOIN inventory_purchase_cost_allocations allocation ON allocation.entry_id=current.id
          WHERE series.seller_key=$1 AND NOT EXISTS (
            SELECT 1 FROM inventory_purchase_cost_allocations invalid_allocation
            JOIN inventory_receipts invalid_receipt ON invalid_receipt.receipt_id=invalid_allocation.receipt_id
            WHERE invalid_allocation.entry_id=current.id AND invalid_receipt.receipt_kind<>'received'
          )
        ) SELECT receipt.receipt_id AS "receiptId",receipt.product_line_id AS "productLineId",
          jsonb_build_object('receiptId',receipt.receipt_id,'productLineId',receipt.product_line_id,
            'quantity',receipt.original_quantity,
            'sellerKey',receipt.seller_key,'intakeAt',receipt.intake_at,'recordedAt',receipt.recorded_at,
            'sourceEvidence',receipt.source_evidence,'intendedSeller',(
              SELECT intended.target_seller_key FROM inventory_publication_receipt_links intended
              WHERE intended.receipt_id=receipt.receipt_id
            )) AS identity,receipt.intake_at AS "occurredAt"
          FROM inventory_receipts receipt
          WHERE (receipt.seller_key=$1 OR EXISTS (SELECT 1 FROM inventory_publication_receipt_links intended
              WHERE intended.receipt_id=receipt.receipt_id AND intended.target_seller_key=$1))
            AND receipt.receipt_kind='received'
            AND NOT EXISTS (SELECT 1 FROM costed WHERE costed.receipt_id=receipt.receipt_id)
          ORDER BY receipt.receipt_id LIMIT 10001`,[seller],executor);
    const loadOrderCoverage=async()=>{
      const row=await queryOne<{
        runId:string;searchRange:string|null;finishedAt:Date;nextOffset:number;expectedTotal:number|null;
        ordersObserved:number;detailsRecorded:number;observedFrom:Date|null;observedThrough:Date|null;
        gaps:Array<{orderNumber?:string}>;
      }>(`SELECT id::text AS "runId",search_range AS "searchRange",finished_at AS "finishedAt",
          next_offset AS "nextOffset",expected_total AS "expectedTotal",orders_observed AS "ordersObserved",
          details_recorded AS "detailsRecorded",observed_from AS "observedFrom",observed_through AS "observedThrough",gaps
        FROM seller_order_sync_runs
        WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND finished_at IS NOT NULL
        ORDER BY finished_at DESC,id DESC LIMIT 1`,[seller],executor);
      return row?{
        runId:row.runId,source:"tcgplayer_api" as const,status:"complete" as const,
        searchRange:row.searchRange,finishedAt:row.finishedAt.toISOString(),nextOffset:row.nextOffset,
        expectedTotal:row.expectedTotal,ordersObserved:row.ordersObserved,detailsRecorded:row.detailsRecorded,
        observedFrom:row.observedFrom?.toISOString()??null,observedThrough:row.observedThrough?.toISOString()??null,
        gaps:(row.gaps??[]).map((gap)=>gap.orderNumber??"<missing order number>"),
      }:null;
    };
    const [purchaseRows,fundingRows,unknownCostRows,orderCoverage]=executor
      ? [await loadPurchases(),await loadFunding(),await loadUnknownCost(),await loadOrderCoverage()] as const
      : await Promise.all([loadPurchases(),loadFunding(),loadUnknownCost(),loadOrderCoverage()]);
    const unknownCost=assertComplete(unknownCostRows,"Unknown-cost receipt evidence");
    return {purchaseRows:assertComplete(purchaseRows,"Current purchase/publication evidence"),
      fundingRows:assertComplete(fundingRows,"Current funding evidence"),unknownCostReceiptCount:unknownCost.length,
      unknownCostReceipts:unknownCost,orderCoverage};
  },

  async findCurrentReport(sellerKey:string):Promise<ReinvestmentTurnaroundReport|null> {
    const row=await queryOne<{report:ReinvestmentTurnaroundReport}>(`SELECT rebuild.report FROM inventory_reinvestment_current_rebuilds current
      JOIN inventory_reinvestment_rebuilds rebuild ON rebuild.id=current.rebuild_id WHERE current.seller_key=$1`,[sellerKey.trim()]);
    return row?.report??null;
  },

  async withRebuildLock<T>(sellerKey:string,fn:(db:Queryable)=>Promise<T>):Promise<T> {
    const db=await getPool().connect();
    const lockKey=`inventory-reinvestment:${sellerKey.trim()}`;
    try {
      // The session lock serializes rebuilds before the repeatable-read snapshot is established.
      await db.query(`SELECT pg_advisory_lock(hashtext($1))`,[lockKey]);
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const result=await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      await db.query(`SELECT pg_advisory_unlock(hashtext($1))`,[lockKey]);
      db.release();
    }
  },

  async saveRebuild(report:ReinvestmentTurnaroundReport,executor?:Queryable):Promise<ReinvestmentTurnaroundReport> {
    const perform=async (db:Queryable)=>{
      let row=await queryOne<{id:string;report:ReinvestmentTurnaroundReport}>(`SELECT id::text AS id,report FROM inventory_reinvestment_rebuilds
        WHERE seller_key=$1 AND rule_version=$2 AND effective_as_of=$3 AND source_fingerprint=$4`,
        [report.sellerKey,report.ruleVersion,report.asOf,report.sourceFingerprint],db);
      const repeated=Boolean(row);
      if (!row) row=await queryOne<{id:string;report:ReinvestmentTurnaroundReport}>(`INSERT INTO inventory_reinvestment_rebuilds
        (seller_key,rule_version,effective_as_of,source_fingerprint,report) VALUES ($1,$2,$3,$4,$5::jsonb)
        RETURNING id::text AS id,report`,[report.sellerKey,report.ruleVersion,report.asOf,report.sourceFingerprint,asJson(report)],db);
      if (!row) throw new Error("Failed to persist the reinvestment rebuild.");
      if (!repeated && report.samples.length) {
        await execute(`INSERT INTO inventory_reinvestment_allocations
          (rebuild_id,sample_key,seller_key,currency,order_number,purchase_reference,receipt_id,amount_cents,sold_at,
           funding_at,published_at,allocation_state,timing_basis,proceeds_provenance,cost_provenance,funding_provenance,
           funding_adjustment_reference,explanation,source_identities)
          SELECT $1,x."sampleKey",$2,x.currency,x."orderNumber",x."purchaseReference",x."receiptId",x."amountCents",
            x."soldAt",x."fundingAt",x."publishedAt",x.state,x."timingBasis",x."proceedsProvenance",x."costProvenance",
            x."fundingProvenance",x."fundingAdjustmentReference",x.explanation,x."sourceIdentities"
          FROM jsonb_to_recordset($3::jsonb) AS x(
            "sampleKey" text,currency text,"orderNumber" text,"purchaseReference" text,"receiptId" integer,
            "amountCents" bigint,"soldAt" timestamptz,"fundingAt" timestamptz,"publishedAt" timestamptz,state text,
            "timingBasis" text,"proceedsProvenance" text,"costProvenance" text,"fundingProvenance" text,
            "fundingAdjustmentReference" text,explanation text,"sourceIdentities" jsonb)`,
          [row.id,report.sellerKey,asJson(report.samples)],db);
      }
      await execute(`INSERT INTO inventory_reinvestment_current_rebuilds (seller_key,rebuild_id) VALUES ($1,$2)
        ON CONFLICT (seller_key) DO UPDATE SET rebuild_id=EXCLUDED.rebuild_id,updated_at=NOW()
        WHERE inventory_reinvestment_current_rebuilds.rebuild_id<>EXCLUDED.rebuild_id`,[report.sellerKey,row.id],db);
      return row.report;
    };
    return executor?perform(executor):this.withRebuildLock(report.sellerKey,perform);
  },
};
