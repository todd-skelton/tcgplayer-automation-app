import assert from "node:assert/strict";
import { createInventoryEconomicsHandlers } from "./api.inventory-economics.server";

const workspace = { sellerKey:"configured-seller",generatedAt:"2026-09-08T00:00:00Z",
  purchaseCosts:[],fundingAdjustments:[],orderExpenses:[],orders:[],uncostedBatches:[] };
const fundingInputs: unknown[] = [];
const handlers = createInventoryEconomicsHandlers({
  getConfig: async () => ({ defaultSellerKey:" configured-seller " }) as never,
  loadWorkspace: async (sellerKey) => ({ ...workspace,sellerKey }),
  recordPurchaseCost: async () => ({ entryId:"1",repeated:false }),
  recordFundingAdjustment: async (input) => { fundingInputs.push(input); return { entryId:"2",repeated:false }; },
  recordOrderExpense: async () => ({ entryId:"3",repeated:false }),
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
console.log("PASS inventory economics API derives seller ownership server-side");
