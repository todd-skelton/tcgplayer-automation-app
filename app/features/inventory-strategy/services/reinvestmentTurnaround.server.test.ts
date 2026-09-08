import assert from "node:assert/strict";
import { allocateReinvestmentTurnaround } from "../domain/allocateReinvestmentTurnaround";
import { buildReinvestmentInput } from "./reinvestmentTurnaround.server";

const {input}=buildReinvestmentInput("synthetic-zero-cost","2026-01-10T00:00:00.000Z",{
  sales:[],unknownProceedsOrderCount:0,unknownProceedsSoldAt:[],sourceEvidenceIdentities:[],
},{purchaseRows:[{purchaseReference:"free-replacement",currency:"USD",totalAmountCents:0,costProvenance:"actual",
  purchasedAt:"2026-01-01",costSourceIdentity:"zero-cost-source",receiptId:42,allocatedAmountCents:0,
  originalQuantity:1,publicationItemId:null,plannedQuantity:null,liveAt:null,publicationState:null,publicationIdentity:null}],
  fundingRows:[],unknownCostReceiptCount:0,unknownCostReceipts:[]});
assert.equal(input.purchases[0].tranches.length,1);
assert.equal(input.purchases[0].tranches[0].amountCents,0);
const report=allocateReinvestmentTurnaround(input);
assert.equal(report.coverage.purchaseCount,1);
assert.equal(report.coverage.costedReceiptCount,1);
assert.equal(report.coverage.unknownCostReceiptCount,0);
assert.equal(report.samples.length,0);
console.log("PASS reinvestment sources preserve a current zero-cost received purchase as known coverage");
