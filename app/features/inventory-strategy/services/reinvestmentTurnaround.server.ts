import { createHash } from "node:crypto";
import { inventoryReinvestmentRepository } from "~/core/db";
import type { Queryable } from "~/core/db/database.server";
import { allocateAmountCents } from "~/features/inventory-economics/domain/money";
import { loadCompleteReusableProceeds } from "~/features/inventory-economics/services/inventoryEconomics.server";
import { allocateReinvestmentTurnaround } from "../domain/allocateReinvestmentTurnaround";
import type {
  ReinvestmentPublicationTranche,
  ReinvestmentTurnaroundInput,
  ReinvestmentTurnaroundReport,
  ReplacementPurchase,
} from "../types/reinvestmentTurnaround";
import type {
  ReinvestmentFundingSourceRow,
  ReinvestmentPurchaseSourceRow,
  ReinvestmentSourceEvidence,
} from "~/core/db/repositories/inventoryReinvestment.server";

function stableJson(value:unknown):string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value==="object") { const record=value as Record<string,unknown>;
    return `{${Object.keys(record).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`; }
  return JSON.stringify(value);
}

function identity(value:unknown):string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function publicationTranches(row:ReinvestmentPurchaseSourceRow):ReinvestmentPublicationTranche[] {
  const validLinkedQuantity=row.plannedQuantity!==null && row.plannedQuantity>0 && row.plannedQuantity<=row.originalQuantity;
  if (row.allocatedAmountCents===0) return [{receiptId:row.receiptId,productLineId:row.productLineId,
    amountCents:0,quantity:row.originalQuantity,
    ...(validLinkedQuantity && row.publicationItemId?{publicationItemId:row.publicationItemId}:{}),
    ...(row.liveAt?{publishedAt:row.liveAt.toISOString()}:{}),publicationState:row.liveAt?"confirmed":validLinkedQuantity?"waiting":"unsupported",
    ...(row.publicationIdentity?{publicationIdentity:identity(row.publicationIdentity)}:{})}];
  if (!validLinkedQuantity) return [{receiptId:row.receiptId,productLineId:row.productLineId,
    amountCents:row.allocatedAmountCents,
    quantity:row.originalQuantity,publicationState:"unsupported"}];
  const targets=[{id:"linked",weight:row.plannedQuantity!},
    ...(row.originalQuantity>row.plannedQuantity!?[{id:"remaining",weight:row.originalQuantity-row.plannedQuantity!}]:[])];
  const amounts=new Map(allocateAmountCents(row.allocatedAmountCents,targets).map((value)=>[value.id,value.amountCents]));
  const publicationIdentity=identity(row.publicationIdentity);
  return [{receiptId:row.receiptId,productLineId:row.productLineId,
    publicationItemId:row.publicationItemId!,amountCents:amounts.get("linked")!,
    quantity:row.plannedQuantity!,...(row.liveAt?{publishedAt:row.liveAt.toISOString()}:{}),
    publicationState:row.liveAt?"confirmed":"waiting",publicationIdentity},
    ...(amounts.has("remaining")?[{receiptId:row.receiptId,productLineId:row.productLineId,
      amountCents:amounts.get("remaining")!,
      quantity:row.originalQuantity-row.plannedQuantity!,publicationState:"unsupported" as const}]:[])];
}

export function buildReinvestmentInput(
  sellerKey:string,
  asOf:string,
  proceeds:Awaited<ReturnType<typeof loadCompleteReusableProceeds>>,
  evidence:ReinvestmentSourceEvidence,
):{input:ReinvestmentTurnaroundInput;orphanFunding:ReinvestmentFundingSourceRow[]} {
  const purchaseFunding=new Map<string,ReinvestmentFundingSourceRow[]>();
  for (const row of evidence.fundingRows.filter((value)=>value.adjustmentType==="purchase_funding")) {
    const key=`${row.currency}\u0000${row.purchaseReference??""}`;
    purchaseFunding.set(key,[...(purchaseFunding.get(key)??[]),row]);
  }
  const purchasesByKey=new Map<string,ReplacementPurchase>();
  for (const row of evidence.purchaseRows) {
    const key=`${row.currency}\u0000${row.purchaseReference}`;
    let purchase=purchasesByKey.get(key);
    if (!purchase) {
      const funding=purchaseFunding.get(key)??[];
      purchase={purchaseReference:row.purchaseReference,currency:row.currency,totalAmountCents:row.totalAmountCents,
        costProvenance:row.costProvenance,costSourceIdentity:row.costSourceIdentity,
        ...(row.purchasedAt?{purchasedAt:row.purchasedAt}:{}),funding:funding.map((value)=>({
          adjustmentReference:value.adjustmentReference,amountCents:value.amountCents,effectiveAt:value.effectiveAt,
          provenance:value.provenance,sourceIdentity:value.sourceIdentity})),tranches:[]};
      purchasesByKey.set(key,purchase); purchaseFunding.delete(key);
    }
    purchase.tranches.push(...publicationTranches(row));
  }
  const orphanFunding=[...purchaseFunding.values()].flat();
  const sourceEvidenceIdentities=[...evidence.purchaseRows.map((row)=>identity(row)),
    ...evidence.fundingRows.map((row)=>row.sourceIdentity),...evidence.unknownCostReceipts.map((row)=>identity(row.identity)),
    ...proceeds.sourceEvidenceIdentities].sort();
  return {input:{sellerKey,asOf,sales:proceeds.sales,purchases:[...purchasesByKey.values()],
    fundingAdjustments:evidence.fundingRows.filter((row):row is ReinvestmentFundingSourceRow &
      {adjustmentType:Exclude<ReinvestmentFundingSourceRow["adjustmentType"],"purchase_funding">}=>row.adjustmentType!=="purchase_funding").map((row)=>({
      adjustmentReference:row.adjustmentReference,currency:row.currency,adjustmentType:row.adjustmentType,
      amountCents:row.amountCents,effectiveAt:row.effectiveAt,provenance:row.provenance,sourceIdentity:row.sourceIdentity})),
    unknownProceedsOrderCount:proceeds.unknownProceedsOrderCount,unknownCostReceiptCount:evidence.unknownCostReceiptCount,
    unknownProceedsSoldAt:proceeds.unknownProceedsSoldAt,
    unknownCostOccurredAt:evidence.unknownCostReceipts.map((row)=>row.occurredAt?.toISOString()??null),
    unknownCostReceipts:evidence.unknownCostReceipts.map((row)=>({receiptId:row.receiptId,
      productLineId:row.productLineId,occurredAt:row.occurredAt?.toISOString()??null})),
    orderCoverage:evidence.orderCoverage,
    sourceEvidenceIdentities},orphanFunding};
}

async function rebuild(sellerKey:string,asOf:string,db:Queryable):Promise<ReinvestmentTurnaroundReport> {
  const proceeds=await loadCompleteReusableProceeds(sellerKey,db);
  const evidence=await inventoryReinvestmentRepository.findSourceEvidence(sellerKey,db);
  const {input,orphanFunding}=buildReinvestmentInput(sellerKey,asOf,proceeds,evidence);
  const report=allocateReinvestmentTurnaround(input);
  if (orphanFunding.length) report.excluded.push({reason:"Purchase-funding evidence without a matching current purchase cost",
    count:orphanFunding.length,amountCents:orphanFunding.reduce((sum,value)=>sum+value.amountCents,0)});
  for (const purchase of input.purchases) {
    const funding=purchase.funding.reduce((sum,value)=>sum+value.amountCents,0);
    if (funding>purchase.totalAmountCents) report.excluded.push({reason:`Purchase funding above current cost for ${purchase.purchaseReference}`,
      count:1,amountCents:funding-purchase.totalAmountCents,currency:purchase.currency});
  }
  return inventoryReinvestmentRepository.saveRebuild(report,db);
}

/** Rebuilds from one repeatable current-version snapshot and atomically advances the persisted current report. */
export async function loadReinvestmentTurnaround(
  sellerKey:string,
  asOf?:Date,
):Promise<ReinvestmentTurnaroundReport> {
  const seller=sellerKey.trim();
  const effectiveAsOf=asOf??new Date(Math.floor(Date.now()/3_600_000)*3_600_000);
  if (!seller) return allocateReinvestmentTurnaround({sellerKey:"",asOf:effectiveAsOf.toISOString(),sales:[],purchases:[],
    fundingAdjustments:[],unknownProceedsOrderCount:0,unknownCostReceiptCount:0,sourceEvidenceIdentities:[]});
  if (Number.isNaN(effectiveAsOf.getTime())) throw new Error("Reinvestment report as-of time is invalid.");
  return inventoryReinvestmentRepository.withRebuildLock(seller,(db)=>rebuild(seller,effectiveAsOf.toISOString(),db));
}

export interface ReinvestmentTurnaroundLoadResult {
  report:ReinvestmentTurnaroundReport|null;
  error:string|null;
}

export async function loadReinvestmentTurnaroundWithRecovery(sellerKey:string):Promise<ReinvestmentTurnaroundLoadResult> {
  try {
    return {report:await loadReinvestmentTurnaround(sellerKey),error:null};
  } catch (error) {
    console.error("Reinvestment turnaround rebuild failed",error);
    const prior=await inventoryReinvestmentRepository.findCurrentReport(sellerKey);
    return {report:prior,error:prior
      ? `Current evidence could not be rebuilt. Showing the saved report effective ${new Date(prior.asOf).toLocaleString()}.`
      : "Reinvestment turnaround could not be rebuilt from complete current evidence."};
  }
}
