import assert from "node:assert/strict";
import { createInventoryEconomicsHandlers } from "./api.inventory-economics.server";

const workspace = { sellerKey:"configured-seller",generatedAt:"2026-09-08T00:00:00Z",
  purchaseCosts:[],fundingAdjustments:[],orderExpenses:[],orders:[],uncostedBatches:[] };
const fundingInputs: unknown[] = [];
const purchaseInputs: unknown[] = [];
const targetInputs: number[][] = [];
const handlers = createInventoryEconomicsHandlers({
  getConfig: async () => ({ defaultSellerKey:" configured-seller " }) as never,
  loadWorkspace: async (sellerKey) => ({ ...workspace,sellerKey }),
  recordPurchaseCost: async (input) => { purchaseInputs.push(input); return { entryId:"1",repeated:false }; },
  recordFundingAdjustment: async (input) => { fundingInputs.push(input); return { entryId:"2",repeated:false }; },
  recordOrderExpense: async () => ({ entryId:"3",repeated:false }),
  findPurchaseAllocationTargets: async (_sellerKey,batchNumbers) => {
    targetInputs.push(batchNumbers);
    return {targets:[{receiptId:10,sku:20,itemLabel:"Synthetic card",originalQuantity:1,
      batchNumbers,intakeAt:"2026-08-02T00:00:00Z"}],complete:true};
  },
  importPurchaseCosts: async () => ({ rows:1,repeated:false }),
});
const loaded = await handlers.loader();
assert.equal((loaded.data as {workspace:typeof workspace}).workspace.sellerKey,"configured-seller");
const response = await handlers.action({ request:new Request("http://localhost/api/inventory-economics",{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ action:"record_funding",
    requestId:"request-1",sellerKey:"attacker-seller",currency:"USD",adjustmentReference:"capital-1",
    adjustmentType:"external_contribution",amount:"10.00",provenance:"actual",effectiveAt:"2026-09-08" }) }) });
assert.equal(response.init?.status,undefined);
assert.equal((fundingInputs[0] as {sellerKey:string}).sellerKey,"configured-seller");
const targetResponse = await handlers.action({ request:new Request("http://localhost/api/inventory-economics",{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
    action:"find_purchase_allocation_targets",requestId:"target-request",batchNumbers:"9,7",currency:"USD",
  }) }) });
assert.deepEqual(targetInputs,[[9,7]]);
assert.equal(((targetResponse.data as {purchaseAllocationTargets:Array<{itemLabel:string}>})
  .purchaseAllocationTargets[0]).itemLabel,"Synthetic card");
const explicitResponse = await handlers.action({ request:new Request("http://localhost/api/inventory-economics",{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ action:"record_purchase_cost",
    requestId:"request-2",currency:"USD",purchaseReference:"invoice-2",totalAmount:"11.00",
    provenance:"actual",allocationRule:"explicit",batchNumbers:"7",marketObservedAt:"stale-value",
    explicitAllocations:[{receiptId:10,amountCents:1000},{receiptId:11,amount:"1.00"}] }) }) });
assert.equal(explicitResponse.init?.status,undefined);
assert.deepEqual((purchaseInputs[0] as {explicitAllocations:unknown}).explicitAllocations,
  [{receiptId:10,amountCents:1000},{receiptId:11,amountCents:100}]);
assert.equal("marketObservedAt" in (purchaseInputs[0] as Record<string,unknown>),false);
await handlers.action({ request:new Request("http://localhost/api/inventory-economics",{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ action:"record_purchase_cost",
    requestId:"request-quantity",currency:"USD",purchaseReference:"invoice-quantity",totalAmount:"1.00",
    provenance:"actual",allocationRule:"quantity",batchNumbers:"7",marketObservedAt:"stale-value" }) }) });
assert.equal("marketObservedAt" in (purchaseInputs[1] as Record<string,unknown>),false);
const duplicateResponse = await handlers.action({ request:new Request("http://localhost/api/inventory-economics",{
  method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ action:"record_purchase_cost",
    requestId:"request-3",currency:"USD",purchaseReference:"invoice-3",totalAmount:"11.00",
    provenance:"actual",allocationRule:"explicit",batchNumbers:"7",
    explicitAllocations:[{receiptId:10,amount:"10.00"},{receiptId:10,amount:"1.00"}] }) }) });
assert.equal(duplicateResponse.init?.status,409);
console.log("PASS inventory economics API derives seller ownership and validates explicit allocations");
