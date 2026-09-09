import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ReinvestmentTurnaround } from "./ReinvestmentTurnaround";
import { allocateReinvestmentTurnaround } from "../domain/allocateReinvestmentTurnaround";

const report=allocateReinvestmentTurnaround({sellerKey:"synthetic-ui",asOf:"2026-01-15T00:00:00.000Z",unknownProceedsOrderCount:1,unsupportedPurchaseFunding:[],
  unknownCostReceiptCount:2,sourceEvidenceIdentities:[],fundingAdjustments:[],
  sales:[{orderNumber:"sale",soldAt:"2026-01-01T00:00:00.000Z",currency:"USD",amountCents:10_000,provenance:"actual",sourceIdentity:"sale"}],
  purchases:[{purchaseReference:"replacement",currency:"USD",totalAmountCents:10_000,costProvenance:"actual",costSourceIdentity:"cost",
    funding:[],tranches:[{receiptId:1,productLineId:1,amountCents:6_000,quantity:6,publishedAt:"2026-01-11T00:00:00.000Z",publicationState:"confirmed"},
      {receiptId:2,productLineId:1,amountCents:4_000,quantity:4,publicationState:"waiting"}]}]});
const html=renderToStaticMarkup(<ReinvestmentTurnaround report={report}/>);
assert.match(html,/Completed \$60\.00/);
assert.match(html,/Waiting \$40\.00/);
assert.match(html,/Completed dollar-weighted mean: 10\.0 days/);
assert.match(html,/sale to publication inference/);
assert.match(html,/Orders without complete reusable-proceeds evidence/);
assert.match(renderToStaticMarkup(<ReinvestmentTurnaround report={null} error="Rebuild failed"/>),/Rebuild failed/);
const fundingReport=allocateReinvestmentTurnaround({sellerKey:"synthetic-funding-ui",asOf:"2026-01-15T00:00:00.000Z",unsupportedPurchaseFunding:[],
  unknownProceedsOrderCount:0,unknownCostReceiptCount:0,sourceEvidenceIdentities:[],sales:[],purchases:[],fundingAdjustments:[
    {adjustmentReference:"opening",currency:"USD",adjustmentType:"opening_cash",amountCents:10_000,effectiveAt:"2026-01-01",provenance:"actual",sourceIdentity:"opening"},
    {adjustmentReference:"bad-release",currency:"USD",adjustmentType:"reserve_release",amountCents:1_000,effectiveAt:"2026-01-02",provenance:"actual",sourceIdentity:"release"},
  ]});
const fundingHtml=renderToStaticMarkup(<ReinvestmentTurnaround report={fundingReport}/>);
assert.match(fundingHtml,/outside funding supplied \$100\.00/i);
assert.match(fundingHtml,/outside cash available \$100\.00/i);
assert.match(fundingHtml,/unsupported funding adjustments \$10\.00/i);
const zeroCostReport=allocateReinvestmentTurnaround({sellerKey:"synthetic-zero-ui",asOf:"2026-01-15T00:00:00.000Z",unsupportedPurchaseFunding:[],
  unknownProceedsOrderCount:0,unknownCostReceiptCount:0,sourceEvidenceIdentities:[],sales:[],fundingAdjustments:[],
  purchases:[{purchaseReference:"free",currency:"USD",totalAmountCents:0,costProvenance:"actual",costSourceIdentity:"free",
    purchasedAt:"2026-01-01",funding:[],tranches:[{receiptId:1,productLineId:1,amountCents:0,quantity:1,publicationState:"waiting"}]}]});
const zeroCostHtml=renderToStaticMarkup(<ReinvestmentTurnaround report={zeroCostReport}/>);
assert.match(zeroCostHtml,/Known replacement purchases: 1/);
assert.match(zeroCostHtml,/costed received lots: 1/);
console.log("PASS reinvestment turnaround renders success, waiting, exclusions, empty, and error states");
