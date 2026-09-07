import assert from "node:assert/strict";
import { applyInventoryOpeningBalance } from "./applyInventoryOpeningBalance.server";

let reads=0;
const replay=await applyInventoryOpeningBalance({
  requestId:"apply-a",runId:"1",evidenceFingerprint:"fp-a",sellerKey:"seller-a",
},{
  findReplay:async()=>({id:"1",status:"applied"}),
  capture:async()=>{reads++;throw new Error("unexpected capture");},
  synchronizeOrders:async()=>{reads++;throw new Error("unexpected sync");},
  apply:async()=>{reads++;throw new Error("unexpected apply");},
} as any);
assert.equal(replay.status,"applied");
assert.equal(reads,0);

const captureRequestIds:string[]=[];
const attempt=()=>applyInventoryOpeningBalance({
  requestId:"apply-b",runId:"2",evidenceFingerprint:"fp-b",sellerKey:"seller-a",
},{
  findReplay:async()=>null,
  capture:async(input:{requestId:string})=>{
    captureRequestIds.push(input.requestId);
    return {id:String(captureRequestIds.length+10),status:"complete"};
  },
  synchronizeOrders:async()=>({coverage:{status:"complete"},changedOrderNumbers:[]}),
  apply:async()=>{throw new Error("coverage has not advanced");},
} as any);
await assert.rejects(attempt,/observation 11/);
await assert.rejects(attempt,/observation 12/);
assert.equal(new Set(captureRequestIds).size,2);
assert.ok(captureRequestIds.every((value)=>value.startsWith("apply-b:inventory-revalidation:")));

console.log("PASS opening apply replays local success and refreshes source proof after an uncommitted attempt");
