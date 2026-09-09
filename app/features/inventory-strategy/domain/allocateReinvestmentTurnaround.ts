import { createHash } from "node:crypto";
import { allocateAmountCents } from "~/features/inventory-economics/domain/money";
import type {
  ReinvestmentCurrencySummary,
  ReinvestmentPublicationTranche,
  ReinvestmentTimingBasis,
  ReinvestmentTurnaroundInput,
  ReinvestmentTurnaroundReport,
  ReinvestmentTurnaroundSample,
  ReplacementPurchase,
  ReusableSaleProceeds,
  UnsupportedPurchaseFunding,
} from "../types/reinvestmentTurnaround";
import { REINVESTMENT_TURNAROUND_RULE_VERSION } from "../types/reinvestmentTurnaround";

const DAY_MILLISECONDS = 86_400_000;

interface MoneyBucket {
  id: string;
  amountCents: number;
  soldAt?: string;
  provenance: "actual" | "estimated";
  sourceIdentity: string;
  sourceIdentities: string[];
}

interface CurrencyState {
  proceeds: MoneyBucket[];
  outside: MoneyBucket[];
  reserves: Array<MoneyBucket & { pool: "proceeds" | "outside" }>;
  eligibleProceedsCents: number;
  negativeProceedsCents: number;
  negativeDeficitCents: number;
  reservedOrWithdrawnCents: number;
  unsupportedFundingAdjustmentCents: number;
  outsideFundingUsedCents: number;
  outsideFundingSuppliedCents: number;
  outsideDeficitSettlementCents: number;
  outsideReservedOrWithdrawnCents: number;
  unresolvedPurchaseCostCents: number;
}

interface PurchaseDemand {
  purchase: ReplacementPurchase;
  tranche: ReinvestmentPublicationTranche;
  fundingAt: string;
  timingBasis: ReinvestmentTimingBasis;
  amountCents: number;
  fundingProvenance: "actual" | "estimated" | "inferred";
  fundingAdjustmentReference?: string;
  fundingSourceIdentity?: string;
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCents(value: number, label: string, signed = false): void {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) {
    throw new Error(`${label} must be ${signed ? "whole" : "nonnegative whole"} cents.`);
  }
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date or timestamp.`);
  return parsed;
}

function dateStart(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Funding and purchase dates must use YYYY-MM-DD.");
  return `${value}T00:00:00.000Z`;
}

function compareIdentity(left: { at: string; rank: number; id: string }, right: { at: string; rank: number; id: string }) {
  return instant(left.at,"Event time") - instant(right.at,"Event time") || left.rank - right.rank || left.id.localeCompare(right.id);
}

function consume(buckets: MoneyBucket[], requestedCents: number): Array<{ bucket: MoneyBucket; amountCents: number }> {
  const consumed: Array<{ bucket: MoneyBucket; amountCents: number }> = [];
  let remaining = requestedCents;
  while (remaining > 0 && buckets.length) {
    const bucket = buckets[0];
    const amountCents = Math.min(remaining,bucket.amountCents);
    consumed.push({ bucket:{...bucket},amountCents });
    bucket.amountCents -= amountCents;
    remaining -= amountCents;
    if (bucket.amountCents === 0) buckets.shift();
  }
  return consumed;
}

function sortProceeds(buckets:MoneyBucket[]):void {
  buckets.sort((left,right)=>instant(left.soldAt!,"Sale time")-instant(right.soldAt!,"Sale time")||left.id.localeCompare(right.id));
}

function settleDeficit(state:CurrencyState,amountCents:number,pool:"proceeds"|"outside"):number {
  const settled=Math.min(state.negativeDeficitCents,amountCents);
  state.negativeDeficitCents-=settled;
  if (pool==="outside") state.outsideDeficitSettlementCents+=settled;
  return amountCents-settled;
}

function splitTranches(purchase: ReplacementPurchase): ReinvestmentPublicationTranche[] {
  const total = purchase.tranches.reduce((sum,tranche)=>sum+tranche.amountCents,0);
  if (total !== purchase.totalAmountCents) throw new Error(`Purchase ${purchase.purchaseReference} tranches must equal its cost.`);
  return [...purchase.tranches].sort((left,right)=>
    (left.publishedAt ? instant(left.publishedAt,"Publication time") : Number.MAX_SAFE_INTEGER) -
      (right.publishedAt ? instant(right.publishedAt,"Publication time") : Number.MAX_SAFE_INTEGER) ||
    left.receiptId-right.receiptId || (left.publicationItemId??"").localeCompare(right.publicationItemId??""));
}

function sortedPurchaseFunding(purchase:ReplacementPurchase):ReplacementPurchase["funding"] {
  return [...purchase.funding].sort((left,right)=>
    left.effectiveAt.localeCompare(right.effectiveAt) || left.adjustmentReference.localeCompare(right.adjustmentReference));
}

export function unsupportedPurchaseFundingFor(purchase:ReplacementPurchase):UnsupportedPurchaseFunding[] {
  let remainingCost=purchase.totalAmountCents;
  return sortedPurchaseFunding(purchase).flatMap((funding)=>{
    const supportedCents=Math.min(funding.amountCents,remainingCost);
    remainingCost-=supportedCents;
    const amountCents=funding.amountCents-supportedCents;
    return amountCents>0?[{kind:"above_current_cost" as const,adjustmentReference:funding.adjustmentReference,
      purchaseReference:purchase.purchaseReference,currency:purchase.currency,amountCents,
      effectiveAt:funding.effectiveAt,sourceIdentity:funding.sourceIdentity}]:[];
  });
}

function demandsForPurchase(purchase: ReplacementPurchase, asOf: string): PurchaseDemand[] {
  const tranches = splitTranches(purchase);
  const knownFunding = sortedPurchaseFunding(purchase);
  if (purchase.totalAmountCents===0) {
    const funding=knownFunding[0];
    if (funding) return tranches.map((tranche)=>({purchase,tranche,fundingAt:dateStart(funding.effectiveAt),
      timingBasis:"known_funding",amountCents:0,fundingProvenance:funding.provenance,
      fundingAdjustmentReference:funding.adjustmentReference,fundingSourceIdentity:funding.sourceIdentity}));
    if (purchase.purchasedAt) return tranches.map((tranche)=>({purchase,tranche,fundingAt:dateStart(purchase.purchasedAt!),
      timingBasis:"known_purchase",amountCents:0,fundingProvenance:purchase.costProvenance}));
    return tranches.map((tranche)=>({purchase,tranche,fundingAt:tranche.publishedAt??asOf,
      timingBasis:"sale_to_publication_inference",amountCents:0,fundingProvenance:"inferred"}));
  }
  if (knownFunding.length) {
    let remainingCost=purchase.totalAmountCents;
    const remainingTrancheCents=tranches.map((tranche)=>tranche.amountCents);
    const demands: PurchaseDemand[]=[];
    for (const funding of knownFunding) {
      const fundedCents=Math.min(funding.amountCents,remainingCost);
      if (fundedCents<=0) continue;
      const allocations=allocateAmountCents(fundedCents,remainingTrancheCents.map((amountCents,index)=>({id:String(index),weight:amountCents})));
      for (const allocation of allocations) {
        if (!allocation.amountCents) continue;
        demands.push({purchase,tranche:tranches[Number(allocation.id)],fundingAt:dateStart(funding.effectiveAt),
          timingBasis:"known_funding",amountCents:allocation.amountCents,fundingProvenance:funding.provenance,
          fundingAdjustmentReference:funding.adjustmentReference,fundingSourceIdentity:funding.sourceIdentity});
        remainingTrancheCents[Number(allocation.id)]-=allocation.amountCents;
      }
      remainingCost-=fundedCents;
    }
    return demands;
  }
  if (purchase.purchasedAt) {
    return tranches.map((tranche)=>({purchase,tranche,fundingAt:dateStart(purchase.purchasedAt!),timingBasis:"known_purchase",
      amountCents:tranche.amountCents,fundingProvenance:purchase.costProvenance}));
  }
  return tranches.map((tranche)=>({purchase,tranche,
    fundingAt:tranche.publishedAt??asOf,timingBasis:"sale_to_publication_inference",amountCents:tranche.amountCents,fundingProvenance:"inferred"}));
}

function weightedDays(samples: ReinvestmentTurnaroundSample[], field: "turnaroundDays"|"waitingAgeDays") {
  const values=samples.flatMap((sample)=>sample[field]===undefined?[]:[{days:sample[field]!,cents:sample.amountCents}]);
  const cents=values.reduce((sum,value)=>sum+value.cents,0);
  if (!cents) return null;
  const microDays=values.reduce((sum,value)=>sum+BigInt(Math.round(value.days*1_000_000))*BigInt(value.cents),0n)/BigInt(cents);
  return Number(microDays)/1_000_000;
}

function weightedPercentile(samples: ReinvestmentTurnaroundSample[], percentile: number) {
  const values=samples.filter((sample)=>sample.turnaroundDays!==undefined)
    .sort((left,right)=>left.turnaroundDays!-right.turnaroundDays! || left.sampleKey.localeCompare(right.sampleKey));
  const total=values.reduce((sum,value)=>sum+BigInt(value.amountCents),0n);
  if (total===0n) return null;
  const target=(total*BigInt(percentile)+99n)/100n;
  let cumulative=0n;
  for (const value of values) { cumulative+=BigInt(value.amountCents); if (cumulative>=target) return value.turnaroundDays!; }
  return values.at(-1)!.turnaroundDays!;
}

function summary(currency: string,state: CurrencyState,samples: ReinvestmentTurnaroundSample[],asOfMilliseconds:number): ReinvestmentCurrencySummary {
  const relevant=samples.filter((sample)=>sample.currency===currency);
  const completed=relevant.filter((sample)=>sample.state==="completed");
  const waiting=relevant.filter((sample)=>sample.state==="waiting");
  const completedCents=completed.reduce((sum,value)=>sum+value.amountCents,0);
  const waitingCents=waiting.reduce((sum,value)=>sum+value.amountCents,0);
  const reinvested=completedCents+waitingCents;
  const available=state.proceeds.reduce((sum,value)=>sum+value.amountCents,0);
  const unallocatedAges=state.proceeds.map((bucket)=>({amountCents:bucket.amountCents,
    ageDays:Math.max(0,(asOfMilliseconds-Date.parse(bucket.soldAt!))/DAY_MILLISECONDS)}));
  return {currency,eligibleProceedsCents:state.eligibleProceedsCents,negativeProceedsCents:state.negativeProceedsCents,
    completedCents,waitingCents,unallocatedProceedsCents:available,reservedOrWithdrawnCents:state.reservedOrWithdrawnCents,
    unsupportedFundingAdjustmentCents:state.unsupportedFundingAdjustmentCents,
    outsideFundingUsedCents:state.outsideFundingUsedCents,outsideFundingSuppliedCents:state.outsideFundingSuppliedCents,
    outsideDeficitSettlementCents:state.outsideDeficitSettlementCents,
    outsideAvailableCents:state.outside.reduce((sum,bucket)=>sum+bucket.amountCents,0),
    outsideReservedOrWithdrawnCents:state.outsideReservedOrWithdrawnCents,
    outstandingNegativeDeficitCents:state.negativeDeficitCents,
    unresolvedPurchaseCostCents:state.unresolvedPurchaseCostCents,
    reinvestedPercent:state.eligibleProceedsCents?reinvested/state.eligibleProceedsCents*100:null,
    completionCoveragePercent:reinvested?completedCents/reinvested*100:null,
    completedDollarWeightedMeanDays:weightedDays(completed,"turnaroundDays"),
    completedWeightedMedianDays:weightedPercentile(completed,50),completedWeightedP90Days:weightedPercentile(completed,90),
    waitingDollarWeightedAgeDays:weightedDays(waiting,"waitingAgeDays"),
    oldestWaitingDays:waiting.length?Math.max(...waiting.map((value)=>value.waitingAgeDays??0)):null,
    unallocatedDollarWeightedAgeDays:unallocatedAges.length
      ? unallocatedAges.reduce((sum,value)=>sum+value.ageDays*value.amountCents,0)/available:null,
    oldestUnallocatedDays:unallocatedAges.length?Math.max(...unallocatedAges.map((value)=>value.ageDays)):null};
}

export function allocateReinvestmentTurnaround(input: ReinvestmentTurnaroundInput): ReinvestmentTurnaroundReport {
  const asOfMilliseconds=instant(input.asOf,"Report as-of time");
  const states=new Map<string,CurrencyState>();
  const getState=(currency:string)=>{ let state=states.get(currency); if (!state) { state={proceeds:[],outside:[],reserves:[],eligibleProceedsCents:0,
    negativeProceedsCents:0,negativeDeficitCents:0,reservedOrWithdrawnCents:0,unsupportedFundingAdjustmentCents:0,
    outsideFundingUsedCents:0,outsideFundingSuppliedCents:0,outsideDeficitSettlementCents:0,
    outsideReservedOrWithdrawnCents:0,unresolvedPurchaseCostCents:0}; states.set(currency,state); } return state; };
  const samples:ReinvestmentTurnaroundSample[]=[];
  const samplesByKey=new Map<string,ReinvestmentTurnaroundSample>();
  const events:Array<{at:string;rank:number;id:string;run:()=>void}>=[];
  let futureOccurrenceCount=0;
  let futureOccurrenceAmountCents=0;
  const recordSample=(purchase:ReplacementPurchase,demand:PurchaseDemand,bucket:MoneyBucket,amountCents:number)=>{
    const publishedAt=demand.tranche.publicationState==="confirmed"?demand.tranche.publishedAt:undefined;
    const completed=publishedAt!==undefined && instant(publishedAt,"Publication time")<=asOfMilliseconds &&
      instant(publishedAt,"Publication time")>=instant(bucket.soldAt!,"Sale time");
    const end=completed?instant(publishedAt!,"Publication time"):asOfMilliseconds;
    const elapsed=Math.max(0,(end-instant(bucket.soldAt!,"Sale time"))/DAY_MILLISECONDS);
    const sourceIdentities=[...bucket.sourceIdentities,purchase.costSourceIdentity,
      ...(demand.tranche.publicationIdentity?[demand.tranche.publicationIdentity]:[]),
      ...(demand.fundingSourceIdentity?[demand.fundingSourceIdentity]:[])].sort();
    const sampleKey=createHash("sha256").update(stableJson({rule:REINVESTMENT_TURNAROUND_RULE_VERSION,currency:purchase.currency,
      sale:bucket.id,purchase:purchase.purchaseReference,receipt:demand.tranche.receiptId,
      productLineId:demand.tranche.productLineId,
      publication:demand.tranche.publicationItemId??null,fundingAt:demand.fundingAt,
      publishedAt:publishedAt??null,sources:sourceIdentities})).digest("hex");
    const prior=samplesByKey.get(sampleKey);
    if (prior) { prior.amountCents+=amountCents; prior.explanation=completed
      ? `${prior.amountCents} cents of pooled ${bucket.provenance} proceeds were attributed to ${purchase.purchaseReference} and its first confirmed supported publication.`
      : `${prior.amountCents} cents of pooled ${bucket.provenance} proceeds were attributed to ${purchase.purchaseReference}; supported publication is still waiting.`; return; }
    const sample:ReinvestmentTurnaroundSample={sampleKey,currency:purchase.currency,orderNumber:bucket.id,purchaseReference:purchase.purchaseReference,
      receiptId:demand.tranche.receiptId,productLineId:demand.tranche.productLineId,
      amountCents,soldAt:bucket.soldAt!,fundingAt:demand.fundingAt,
      ...(completed?{publishedAt,turnaroundDays:elapsed}:{waitingAgeDays:elapsed}),state:completed?"completed":"waiting",
      timingBasis:demand.timingBasis,proceedsProvenance:bucket.provenance,costProvenance:purchase.costProvenance,
      fundingProvenance:demand.fundingProvenance,
      ...(demand.fundingAdjustmentReference?{fundingAdjustmentReference:demand.fundingAdjustmentReference}:{}),
      explanation:completed
        ? `${amountCents} cents of pooled ${bucket.provenance} proceeds were attributed to ${purchase.purchaseReference} and its first confirmed supported publication.`
        : `${amountCents} cents of pooled ${bucket.provenance} proceeds were attributed to ${purchase.purchaseReference}; supported publication is still waiting.`,
      sourceIdentities};
    samples.push(sample); samplesByKey.set(sampleKey,sample);
  };

  for (const adjustment of input.fundingAdjustments) {
    assertCents(adjustment.amountCents,`Funding adjustment ${adjustment.adjustmentReference}`);
    const at=dateStart(adjustment.effectiveAt);
    if (instant(at,"Funding adjustment date")>asOfMilliseconds) {
      futureOccurrenceCount+=1; futureOccurrenceAmountCents+=adjustment.amountCents; continue;
    }
    const state=getState(adjustment.currency);
    if (adjustment.adjustmentType==="opening_cash" || adjustment.adjustmentType==="external_contribution") {
      events.push({at,rank:0,id:`adjustment:${adjustment.adjustmentReference}`,run:()=>{
        state.outsideFundingSuppliedCents+=adjustment.amountCents;
        const amountCents=settleDeficit(state,adjustment.amountCents,"outside");
        if (amountCents) state.outside.push({id:adjustment.adjustmentReference,
          amountCents,provenance:adjustment.provenance,sourceIdentity:adjustment.sourceIdentity,
          sourceIdentities:[adjustment.sourceIdentity]});
      }});
    } else if (adjustment.adjustmentType==="reserve_release") {
      events.push({at,rank:0,id:`adjustment:${adjustment.adjustmentReference}`,run:()=>{
        let remaining=adjustment.amountCents;
        while (remaining>0 && state.reserves.length) {
          const held=state.reserves[0]; const amountCents=Math.min(remaining,held.amountCents);
          const target=held.pool==="proceeds"?state.proceeds:state.outside;
          const releasedCents=settleDeficit(state,amountCents,held.pool);
          if (releasedCents) target.push({id:held.id,amountCents:releasedCents,soldAt:held.soldAt,
            provenance:held.provenance,sourceIdentity:held.sourceIdentity,sourceIdentities:held.sourceIdentities});
          held.amountCents-=amountCents; remaining-=amountCents; state.reservedOrWithdrawnCents-=amountCents;
          if (held.pool==="outside") state.outsideReservedOrWithdrawnCents-=amountCents;
          if (held.amountCents===0) state.reserves.shift();
        }
        sortProceeds(state.proceeds);
        state.unsupportedFundingAdjustmentCents+=remaining;
      }});
    } else {
      events.push({at,rank:1,id:`adjustment:${adjustment.adjustmentReference}`,run:()=>{
        const fromProceeds=consume(state.proceeds,adjustment.amountCents);
        const proceedsCents=fromProceeds.reduce((sum,value)=>sum+value.amountCents,0);
        const fromOutside=consume(state.outside,adjustment.amountCents-proceedsCents);
        const removedCents=proceedsCents+fromOutside.reduce((sum,value)=>sum+value.amountCents,0);
        state.reservedOrWithdrawnCents+=removedCents;
        state.outsideReservedOrWithdrawnCents+=fromOutside.reduce((sum,value)=>sum+value.amountCents,0);
        state.unsupportedFundingAdjustmentCents+=adjustment.amountCents-removedCents;
        if (adjustment.adjustmentType==="reserve") {
          state.reserves.push(...fromProceeds.map(({bucket,amountCents})=>({...bucket,amountCents,pool:"proceeds" as const})),
            ...fromOutside.map(({bucket,amountCents})=>({...bucket,amountCents,pool:"outside" as const})));
        }
      }});
    }
  }

  for (const sale of input.sales) {
    assertCents(sale.amountCents,`Sale ${sale.orderNumber}`,true);
    if (instant(sale.soldAt,"Sale time")>asOfMilliseconds) {
      futureOccurrenceCount+=1; futureOccurrenceAmountCents+=Math.abs(sale.amountCents); continue;
    }
    const state=getState(sale.currency);
    events.push({at:sale.soldAt,rank:3,id:`sale:${sale.orderNumber}`,run:()=>{
      if (sale.amountCents>0) { state.eligibleProceedsCents+=sale.amountCents;
        const amountCents=settleDeficit(state,sale.amountCents,"proceeds");
        if (amountCents) state.proceeds.push({id:sale.orderNumber,amountCents,soldAt:sale.soldAt,
          provenance:sale.provenance,sourceIdentity:sale.sourceIdentity,
          sourceIdentities:sale.sourceIdentities??[sale.sourceIdentity]}); }
      else if (sale.amountCents<0) { const reduction=-sale.amountCents; state.negativeProceedsCents+=reduction;
        const consumed=consume(state.proceeds,reduction).reduce((sum,value)=>sum+value.amountCents,0);
        let remaining=reduction-consumed;
        while (remaining>0 && state.reserves.length) {
          const held=state.reserves[0]; const amountCents=Math.min(remaining,held.amountCents);
          held.amountCents-=amountCents; remaining-=amountCents; state.reservedOrWithdrawnCents-=amountCents;
          if (held.pool==="outside") { state.outsideReservedOrWithdrawnCents-=amountCents;
            state.outsideDeficitSettlementCents+=amountCents; }
          if (held.amountCents===0) state.reserves.shift();
        }
        const outside=consume(state.outside,remaining).reduce((sum,value)=>sum+value.amountCents,0);
        state.outsideDeficitSettlementCents+=outside;
        state.negativeDeficitCents+=remaining-outside; }
    }});
  }

  for (const purchase of input.purchases) {
    assertCents(purchase.totalAmountCents,`Purchase ${purchase.purchaseReference}`);
    const funded=demandsForPurchase(purchase,input.asOf);
    const eligibleDemands=funded.filter((demand)=>instant(demand.fundingAt,"Purchase funding time")<=asOfMilliseconds);
    if (!eligibleDemands.length) {
      futureOccurrenceCount+=1; futureOccurrenceAmountCents+=purchase.totalAmountCents; continue;
    }
    const fundedCents=eligibleDemands.reduce((sum,value)=>sum+value.amountCents,0);
    getState(purchase.currency).unresolvedPurchaseCostCents+=purchase.totalAmountCents-fundedCents;
    const groups=new Map<string,PurchaseDemand[]>();
    for (const demand of eligibleDemands) {
      const key=[demand.fundingAt,demand.fundingAdjustmentReference??"",demand.fundingSourceIdentity??""].join("\u0000");
      groups.set(key,[...(groups.get(key)??[]),demand]);
    }
    for (const demands of groups.values()) {
      const first=demands[0];
      const state=getState(purchase.currency);
      events.push({at:first.fundingAt,rank:2,id:`purchase:${purchase.purchaseReference}:${first.fundingAdjustmentReference??"cost"}`,
        run:()=>{
          const demandedCents=demands.reduce((sum,demand)=>sum+demand.amountCents,0);
          const outside=consume(state.outside,demandedCents).reduce((sum,value)=>sum+value.amountCents,0);
          state.outsideFundingUsedCents+=outside;
          const proceedsNeeded=demandedCents-outside;
          const attributed=consume(state.proceeds,proceedsNeeded);
          const attributedCents=attributed.reduce((sum,value)=>sum+value.amountCents,0);
          state.unresolvedPurchaseCostCents+=proceedsNeeded-attributedCents;
          const targetAmounts=attributedCents
            ? allocateAmountCents(attributedCents,demands.map((demand,index)=>({id:String(index),weight:demand.amountCents}))) : [];
          let bucketIndex=0;
          let bucketRemaining=attributed[0]?.amountCents??0;
          for (const target of targetAmounts) {
            let targetRemaining=target.amountCents;
            while (targetRemaining>0 && bucketIndex<attributed.length) {
              const amountCents=Math.min(targetRemaining,bucketRemaining);
              recordSample(purchase,demands[Number(target.id)],attributed[bucketIndex].bucket,amountCents);
              targetRemaining-=amountCents; bucketRemaining-=amountCents;
              if (bucketRemaining===0) { bucketIndex+=1; bucketRemaining=attributed[bucketIndex]?.amountCents??0; }
            }
          }
        }});
    }
  }
  events.sort(compareIdentity).forEach((event)=>event.run());
  samples.sort((left,right)=>left.currency.localeCompare(right.currency)||left.soldAt.localeCompare(right.soldAt)||left.sampleKey.localeCompare(right.sampleKey));
  const sourceFingerprint=createHash("sha256").update(stableJson({ruleVersion:REINVESTMENT_TURNAROUND_RULE_VERSION,input})).digest("hex");
  const futureUnknownProceeds=(input.unknownProceedsSoldAt??[]).filter((soldAt)=>soldAt!==null &&
    instant(soldAt,"Unknown-proceeds sale time")>asOfMilliseconds).length;
  const unknownProceedsOrderCount=Math.max(0,input.unknownProceedsOrderCount-futureUnknownProceeds);
  const futureUnknownCosts=(input.unknownCostOccurredAt??[]).filter((occurredAt)=>occurredAt!==null &&
    instant(occurredAt,"Unknown-cost receipt occurrence")>asOfMilliseconds).length;
  const unknownCostReceiptCount=Math.max(0,input.unknownCostReceiptCount-futureUnknownCosts);
  const excluded=[
    ...(unknownProceedsOrderCount?[{reason:"Orders without complete reusable-proceeds evidence",count:unknownProceedsOrderCount}]:[]),
    ...(unknownCostReceiptCount?[{reason:"Receipt lots without a current supported cost",count:unknownCostReceiptCount}]:[]),
    ...(futureOccurrenceCount+futureUnknownProceeds+futureUnknownCosts?[{reason:"Evidence with an occurrence after the effective as-of cutoff",
      count:futureOccurrenceCount+futureUnknownProceeds+futureUnknownCosts,amountCents:futureOccurrenceAmountCents}]:[]),
  ];
  const eligibleSaleCount=input.sales.filter((sale)=>instant(sale.soldAt,"Sale time")<=asOfMilliseconds).length;
  const observedPurchases=input.purchases.filter((purchase)=>demandsForPurchase(purchase,input.asOf)
    .some((demand)=>instant(demand.fundingAt,"Purchase funding time")<=asOfMilliseconds));
  const observedPurchaseCount=observedPurchases.length;
  const costedReceiptCount=new Set(observedPurchases.flatMap((purchase)=>purchase.tranches.map((tranche)=>tranche.receiptId))).size;
  return {sellerKey:input.sellerKey,asOf:input.asOf,ruleVersion:REINVESTMENT_TURNAROUND_RULE_VERSION,sourceFingerprint,
    currentCorrectedView:true,datePrecision:"timestamp_sales_date_funding",
    currencies:[...states.entries()].sort(([left],[right])=>left.localeCompare(right)).map(([currency,state])=>{
      const result=summary(currency,state,samples,asOfMilliseconds);
      const proceeds=state.proceeds;
      if (proceeds.length) {
        const amount=proceeds.reduce((sum,value)=>sum+value.amountCents,0);
        const ages=proceeds.map((value)=>({cents:value.amountCents,days:Math.max(0,(asOfMilliseconds-instant(value.soldAt!,"Sale time"))/DAY_MILLISECONDS)}));
        result.unallocatedDollarWeightedAgeDays=ages.reduce((sum,value)=>sum+value.cents*value.days,0)/amount;
        result.oldestUnallocatedDays=Math.max(...ages.map((value)=>value.days));
      }
      return result;
    }),
    samples,unsupportedPurchaseFunding:input.unsupportedPurchaseFunding,excluded,
    coverage:{observedOrderCount:eligibleSaleCount+unknownProceedsOrderCount,eligibleOrderCount:eligibleSaleCount,
      unknownProceedsOrderCount,purchaseCount:observedPurchaseCount,costedReceiptCount,unknownCostReceiptCount,
      unknownProceeds:(input.unknownProceedsSoldAt??[]).map((soldAt)=>({soldAt})),
      unknownCosts:(input.unknownCostReceipts??[]).map((value)=>({...value}))},
    orderCoverage:input.orderCoverage??null,
    convention:[
      "Financial pooled attribution is an estimate; it is separate from physical FIFO and does not prove bank cash availability.",
      "Outside and opening cash funds purchases before sale proceeds. A reserve retains its original source and sale age; only held reserve can be released. Reserves, withdrawals, and negative proceeds make sale proceeds unavailable first.",
      "Known date-only purchase or funding evidence occurs before timestamped sales on the same date; same-day sales are not treated as earlier funding.",
      "Missing purchase timing uses a labeled sale-to-publication inference. Current corrected source versions are rebuilt; recorded-at history is not treated as occurrence time.",
      "Percentage reinvested uses all positive eligible proceeds as its denominator, including proceeds later reserved, withdrawn, or offset by negative effects.",
    ]};
}
