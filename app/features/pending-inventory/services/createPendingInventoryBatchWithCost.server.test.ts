import assert from "node:assert/strict";
import type { Queryable } from "~/core/db/database.server";
import { createPendingInventoryBatchWithCost } from "./createPendingInventoryBatchWithCost.server";

const purchaseCost = {
  requestId:"batch-1:purchase-cost",sellerKey:"seller",purchaseReference:"invoice",currency:"USD",
  totalAmountCents:100,provenance:"actual" as const,source:"intake" as const,allocationRule:"quantity" as const,
};
let state = { batches:0,costs:0,estimates:[] as Array<{sellerKey:string;batchNumbers?:number[]}> };
const transaction = async <T>(work:(executor:Queryable)=>Promise<T>) => {
  const before = {...state,estimates:[...state.estimates]};
  try { return await work({} as Queryable); }
  catch (error) { state=before; throw error; }
};
const rates: unknown[] = [];
const createBatch = async (_requestId:string,_executor?:Queryable,rate?:unknown) => { state.batches += 1; rates.push(rate); return {batchNumber:7} as never; };
const recordEstimatedPurchaseCosts = (async (sellerKey:string,options:{batchNumbers?:number[]}={}) => {
  state.estimates.push({sellerKey,batchNumbers:options.batchNumbers});
  return { rule:{} as never,recorded:[],repeated:[],marketUnavailable:[] };
}) as never;
await assert.rejects(createPendingInventoryBatchWithCost("batch-1",{purchaseCost,estimateForSeller:"seller"},{
  transaction,createBatch,recordEstimatedPurchaseCosts,
  recordPurchaseCost:async()=>{ state.costs += 1; throw new Error("late database failure"); },
}),/late database failure/);
assert.deepEqual(state,{batches:0,costs:0,estimates:[]});

const created = await createPendingInventoryBatchWithCost("batch-1",{purchaseCost,estimateForSeller:"seller"},{
  transaction,createBatch,recordEstimatedPurchaseCosts,
  recordPurchaseCost:async()=>{ state.costs += 1; return {entryId:"1",repeated:false}; },
});
assert.equal(created?.batchNumber,7);
assert.deepEqual(state,{batches:1,costs:1,estimates:[]});

const estimated = await createPendingInventoryBatchWithCost("batch-2",{estimateForSeller:"seller"},{
  transaction,createBatch,recordEstimatedPurchaseCosts,
  recordPurchaseCost:async()=>{ throw new Error("entered cost must not be recorded"); },
});
assert.equal(estimated?.batchNumber,7);
assert.deepEqual(state,{batches:2,costs:1,estimates:[{sellerKey:"seller",batchNumbers:[7]}]});

const uncosted = await createPendingInventoryBatchWithCost("batch-3",{estimateForSeller:null},{
  transaction,createBatch,recordEstimatedPurchaseCosts,
  recordPurchaseCost:async()=>{ throw new Error("entered cost must not be recorded"); },
});
assert.equal(uncosted?.batchNumber,7);
assert.deepEqual(state,{batches:3,costs:1,estimates:[{sellerKey:"seller",batchNumbers:[7]}]});

const rate = { marketRate:0.6, perUnitDeductionCents:50 };
const atRate = await createPendingInventoryBatchWithCost("batch-4",{estimateForSeller:"seller",estimatedCostRate:rate},{
  transaction,createBatch,recordEstimatedPurchaseCosts,
  recordPurchaseCost:async()=>{ throw new Error("entered cost must not be recorded"); },
});
assert.equal(atRate?.batchNumber,7);
assert.deepEqual(rates.at(-1),rate,"the batch is created with its cost rate so later estimates keep it");
assert.deepEqual(state.estimates.at(-1),{sellerKey:"seller",batchNumbers:[7]});
await assert.rejects(createPendingInventoryBatchWithCost("batch-5",{purchaseCost,estimateForSeller:"seller",estimatedCostRate:rate},{
  transaction,createBatch,recordEstimatedPurchaseCosts,recordPurchaseCost:async()=>({entryId:"1",repeated:false}),
}),/not both/);
await assert.rejects(createPendingInventoryBatchWithCost("batch-6",{estimateForSeller:null,estimatedCostRate:rate},{
  transaction,createBatch,recordEstimatedPurchaseCosts,recordPurchaseCost:async()=>({entryId:"1",repeated:false}),
}),/needs a seller/);
assert.equal(state.batches,4,"a rejected cost choice creates no batch");

console.log("PASS pending batch records entered cost, else the seller's estimated cost at the batch's rate, in one transaction");