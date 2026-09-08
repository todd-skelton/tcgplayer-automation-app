import assert from "node:assert/strict";
import type { Queryable } from "~/core/db/database.server";
import { createPendingInventoryBatchWithCost } from "./createPendingInventoryBatchWithCost.server";

const purchaseCost = {
  requestId:"batch-1:purchase-cost",sellerKey:"seller",purchaseReference:"invoice",currency:"USD",
  totalAmountCents:100,provenance:"actual" as const,source:"intake" as const,allocationRule:"quantity" as const,
};
let state = { batches:0,costs:0 };
const transaction = async <T>(work:(executor:Queryable)=>Promise<T>) => {
  const before = {...state};
  try { return await work({} as Queryable); }
  catch (error) { state=before; throw error; }
};
const createBatch = async () => { state.batches += 1; return {batchNumber:7} as never; };
await assert.rejects(createPendingInventoryBatchWithCost("batch-1",purchaseCost,{
  transaction,createBatch,
  recordPurchaseCost:async()=>{ state.costs += 1; throw new Error("late database failure"); },
}),/late database failure/);
assert.deepEqual(state,{batches:0,costs:0});

const created = await createPendingInventoryBatchWithCost("batch-1",purchaseCost,{
  transaction,createBatch,
  recordPurchaseCost:async()=>{ state.costs += 1; return {entryId:"1",repeated:false}; },
});
assert.equal(created?.batchNumber,7);
assert.deepEqual(state,{batches:1,costs:1});

console.log("PASS pending batch and requested purchase cost share one transaction");
