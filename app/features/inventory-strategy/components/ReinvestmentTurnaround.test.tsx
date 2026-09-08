import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ReinvestmentTurnaround } from "./ReinvestmentTurnaround";
import { allocateReinvestmentTurnaround } from "../domain/allocateReinvestmentTurnaround";

const report=allocateReinvestmentTurnaround({sellerKey:"synthetic-ui",asOf:"2026-01-15T00:00:00.000Z",unknownProceedsOrderCount:1,
  unknownCostReceiptCount:2,sourceEvidenceIdentities:[],fundingAdjustments:[],
  sales:[{orderNumber:"sale",soldAt:"2026-01-01T00:00:00.000Z",currency:"USD",amountCents:10_000,provenance:"actual",sourceIdentity:"sale"}],
  purchases:[{purchaseReference:"replacement",currency:"USD",totalAmountCents:10_000,costProvenance:"actual",costSourceIdentity:"cost",
    funding:[],tranches:[{receiptId:1,amountCents:6_000,quantity:6,publishedAt:"2026-01-11T00:00:00.000Z",publicationState:"confirmed"},
      {receiptId:2,amountCents:4_000,quantity:4,publicationState:"waiting"}]}]});
const html=renderToStaticMarkup(<ReinvestmentTurnaround report={report}/>);
assert.match(html,/Completed \$60\.00/);
assert.match(html,/Waiting \$40\.00/);
assert.match(html,/Completed dollar-weighted mean: 10\.0 days/);
assert.match(html,/sale to publication inference/);
assert.match(html,/Orders without complete reusable-proceeds evidence/);
assert.match(renderToStaticMarkup(<ReinvestmentTurnaround report={null} error="Rebuild failed"/>),/Rebuild failed/);
console.log("PASS reinvestment turnaround renders success, waiting, exclusions, empty, and error states");
