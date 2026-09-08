import assert from "node:assert/strict";
import { allocateReinvestmentTurnaround } from "./allocateReinvestmentTurnaround";
import type { ReinvestmentTurnaroundInput } from "../types/reinvestmentTurnaround";

const input:ReinvestmentTurnaroundInput={sellerKey:"synthetic-turnaround",asOf:"2026-01-21T00:00:00.000Z",unknownProceedsOrderCount:0,unknownCostReceiptCount:0,sourceEvidenceIdentities:[],
  sales:[{orderNumber:"sale-1",soldAt:"2026-01-01T00:00:00.000Z",currency:"USD",amountCents:10_000,provenance:"actual",sourceIdentity:"sale-source"}],
  fundingAdjustments:[],purchases:[{purchaseReference:"replacement",currency:"USD",totalAmountCents:10_000,costProvenance:"actual",
    costSourceIdentity:"cost-source",funding:[],tranches:[
      {receiptId:1,amountCents:6_000,quantity:6,publishedAt:"2026-01-11T00:00:00.000Z",publicationState:"confirmed",publicationIdentity:"pub-1"},
      {receiptId:2,amountCents:4_000,quantity:4,publishedAt:"2026-01-21T00:00:00.000Z",publicationState:"confirmed",publicationIdentity:"pub-2"},
    ]}]};
const completed=allocateReinvestmentTurnaround(input);
assert.equal(completed.currencies[0].completedCents,10_000);
assert.equal(completed.currencies[0].completedDollarWeightedMeanDays,14);
assert.equal(completed.currencies[0].completedWeightedMedianDays,10);
assert.equal(completed.currencies[0].completedWeightedP90Days,20);

const waiting=allocateReinvestmentTurnaround({...input,asOf:"2026-01-15T00:00:00.000Z",purchases:[{...input.purchases[0],tranches:[
  input.purchases[0].tranches[0],{...input.purchases[0].tranches[1],publishedAt:undefined,publicationState:"waiting"}]}]});
assert.equal(waiting.currencies[0].completedCents,6_000);
assert.equal(waiting.currencies[0].waitingCents,4_000);
assert.equal(waiting.currencies[0].completedDollarWeightedMeanDays,10);
assert.equal(waiting.currencies[0].completionCoveragePercent,60);

const knownFunding=allocateReinvestmentTurnaround({...input,sales:[{...input.sales[0],soldAt:"2026-01-03T00:00:00.000Z"}],purchases:[{...input.purchases[0],
  funding:[{adjustmentReference:"funded-early",amountCents:10_000,effectiveAt:"2026-01-02",provenance:"actual",sourceIdentity:"fund-source"}]}]});
assert.equal(knownFunding.currencies[0].completedCents,0);
assert.equal(knownFunding.currencies[0].unresolvedPurchaseCostCents,10_000);
assert.equal(knownFunding.currencies[0].unallocatedProceedsCents,10_000);

const outsideFirst=allocateReinvestmentTurnaround({...input,fundingAdjustments:[{adjustmentReference:"outside",currency:"USD",adjustmentType:"external_contribution",
  amountCents:4_000,effectiveAt:"2026-01-01",provenance:"actual",sourceIdentity:"outside-source"}]});
assert.equal(outsideFirst.currencies[0].outsideFundingUsedCents,4_000);
assert.equal(outsideFirst.currencies[0].completedCents,6_000);
assert.equal(outsideFirst.currencies[0].unallocatedProceedsCents,4_000);

const repeat=allocateReinvestmentTurnaround(input);
assert.deepEqual(repeat,completed);

const cents=allocateReinvestmentTurnaround({...input,sales:[
  {...input.sales[0],orderNumber:"cent-1",amountCents:1},
  {...input.sales[0],orderNumber:"cent-2",amountCents:1},
],purchases:[{...input.purchases[0],totalAmountCents:2,tranches:[
  {...input.purchases[0].tranches[0],amountCents:1,quantity:1},
  {...input.purchases[0].tranches[1],amountCents:1,quantity:1},
]}]});
assert.deepEqual(cents.samples.map((sample)=>sample.amountCents),[1,1]);
assert.equal(cents.currencies[0].completedDollarWeightedMeanDays,15);

const beforeSale=allocateReinvestmentTurnaround({...input,asOf:"2025-12-31T00:00:00.000Z"});
assert.equal(beforeSale.coverage.eligibleOrderCount,0);
assert.equal(beforeSale.currencies.length,0);
console.log("PASS pooled reinvestment attribution preserves cents, timing, partial publication, and rebuild identity");
