import assert from "node:assert/strict";
import { allocateReinvestmentTurnaround } from "../domain/allocateReinvestmentTurnaround";
import { buildReinvestmentInput } from "./reinvestmentTurnaround.server";

const {input}=buildReinvestmentInput("synthetic-zero-cost","2026-01-10T00:00:00.000Z",{
  sales:[],unknownProceedsOrderCount:0,unknownProceedsSoldAt:[],sourceEvidenceIdentities:[],
},{purchaseRows:[{purchaseReference:"free-replacement",currency:"USD",totalAmountCents:0,costProvenance:"actual",
  purchasedAt:"2026-01-01",costSourceIdentity:"zero-cost-source",receiptId:42,productLineId:1,allocatedAmountCents:0,
  originalQuantity:1,publicationItemId:null,plannedQuantity:null,liveAt:null,publicationState:null,publicationIdentity:null}],
  fundingRows:[],unknownCostReceiptCount:0,unknownCostReceipts:[],orderCoverage:null});
assert.equal(input.purchases[0].tranches.length,1);
assert.equal(input.purchases[0].tranches[0].amountCents,0);
const report=allocateReinvestmentTurnaround(input);
assert.equal(report.coverage.purchaseCount,1);
assert.equal(report.coverage.costedReceiptCount,1);
assert.equal(report.coverage.unknownCostReceiptCount,0);
assert.equal(report.samples.length,0);

const signed=buildReinvestmentInput("synthetic-signed-cost","2026-01-10T00:00:00.000Z",{
  sales:[],unknownProceedsOrderCount:0,unknownProceedsSoldAt:[],sourceEvidenceIdentities:[],
},{purchaseRows:[600,300,-90].map((allocatedAmountCents,index)=>({purchaseReference:"estimated:batch-1",currency:"USD",
  totalAmountCents:810,costProvenance:"estimated" as const,purchasedAt:"2026-01-01",costSourceIdentity:"estimate",
  receiptId:index+1,productLineId:1,allocatedAmountCents,originalQuantity:1,publicationItemId:null,plannedQuantity:null,
  liveAt:null,publicationState:null,publicationIdentity:null})),
  fundingRows:[],unknownCostReceiptCount:0,unknownCostReceipts:[],orderCoverage:null}).input;
assert.equal(signed.purchases[0].totalAmountCents,810);
assert.deepEqual(signed.purchases[0].tranches.map((tranche)=>[tranche.receiptId,tranche.amountCents]),[[1,540],[2,270],[3,0]],
  "a lot that cost less than nothing carries no capital and offsets the other lots");
assert.equal(allocateReinvestmentTurnaround(signed).coverage.costedReceiptCount,3);

const purchaseRow={purchaseReference:"replacement",currency:"USD",totalAmountCents:10_000,costProvenance:"actual" as const,
  purchasedAt:"2026-01-01",costSourceIdentity:"cost",receiptId:1,productLineId:1,allocatedAmountCents:10_000,
  originalQuantity:1,publicationItemId:null,plannedQuantity:null,liveAt:null,publicationState:null,publicationIdentity:null};
const fundingRow=(adjustmentReference:string,currency:string,amountCents:number,effectiveAt:string,purchaseReference:string|null)=>({
  adjustmentReference,currency,adjustmentType:"purchase_funding" as const,amountCents,provenance:"actual" as const,
  effectiveAt,purchaseReference,sourceIdentity:`source-${adjustmentReference}`,
});
const source=(fundingRows:ReturnType<typeof fundingRow>[])=>buildReinvestmentInput("seller","2026-01-10T00:00:00.000Z",{
  sales:[],unknownProceedsOrderCount:0,unknownProceedsSoldAt:[],sourceEvidenceIdentities:[],
},{purchaseRows:[purchaseRow],fundingRows,unknownCostReceiptCount:0,unknownCostReceipts:[],orderCoverage:null}).input;

const excess=source([fundingRow("current","USD",12_000,"2026-01-02","replacement")]);
assert.deepEqual(excess.unsupportedPurchaseFunding.map(({currency,amountCents,effectiveAt})=>({currency,amountCents,effectiveAt})),
  [{currency:"USD",amountCents:2_000,effectiveAt:"2026-01-02"}]);
const corrected=source([fundingRow("current","USD",10_000,"2026-01-02","replacement")]);
assert.deepEqual(corrected.unsupportedPurchaseFunding,[]);
const future=source([fundingRow("current","USD",10_000,"2026-01-02","replacement"),
  fundingRow("future","USD",2_000,"2026-01-20","replacement")]);
assert.deepEqual(future.unsupportedPurchaseFunding.map(({amountCents,effectiveAt})=>({amountCents,effectiveAt})),
  [{amountCents:2_000,effectiveAt:"2026-01-20"}]);
const orphan=source([fundingRow("current","USD",10_000,"2026-01-02","replacement"),
  fundingRow("orphan-eur","EUR",2_000,"2026-01-03","missing")]);
assert.deepEqual(orphan.unsupportedPurchaseFunding.map(({kind,currency,amountCents})=>({kind,currency,amountCents})),
  [{kind:"orphan",currency:"EUR",amountCents:2_000}]);
assert.notEqual(allocateReinvestmentTurnaround(excess).sourceFingerprint,allocateReinvestmentTurnaround(corrected).sourceFingerprint);
console.log("PASS reinvestment sources preserve zero cost and type current, corrected, future, and orphan purchase funding");
