import assert from "node:assert/strict";
import { parseCompleteInventoryExport, quantityFingerprint, validateSellerPricingContext } from "./inventoryObservation";
import { captureInventoryObservation } from "../services/captureInventoryObservation.server";

const csv=(quantity:number,price="1.00")=>`TCGplayer Id,Product Line,Set Name,Product Name,Condition,Total Quantity,TCG Marketplace Price\n100,Game,Set,Card,Near Mint,${quantity},${price}`;
validateSellerPricingContext(`{'sellerKey': 'seller-a'} sellerKey: 'seller-a'`,"seller-a");
assert.throws(()=>validateSellerPricingContext(`{'sellerKey': 'seller-b'} sellerKey: 'seller-b'`,"seller-a"),/does not match/);
assert.throws(()=>validateSellerPricingContext(`sellerKey: 'seller-a'`,"seller-a"),/declarations/);
const one=parseCompleteInventoryExport(csv(2));
assert.equal(one[0]?.quantity,2);
assert.equal(quantityFingerprint(one),quantityFingerprint(parseCompleteInventoryExport(csv(2,"9.99"))));
assert.throws(()=>parseCompleteInventoryExport(`${csv(2)}\n100,Game,Set,Card,Near Mint,2,1.00`),/repeats SKU/);
assert.throws(()=>parseCompleteInventoryExport(csv(2_147_483_648)),/invalid SKU or quantity/);

let recorded:any;
const exports=[csv(2,"1.00"),csv(2,"1.25")];
await captureInventoryObservation({requestId:"r1",sellerKey:"seller-a"},{
  begin:async()=>({state:"claimed",claimToken:"00000000-0000-0000-0000-000000000001"}), fail:async()=>{},
  getContext:async()=>`{'sellerKey': 'seller-a'} sellerKey: 'seller-a'`, exportInventory:async()=>exports.shift()!,
  now:()=>new Date("2026-09-07T12:00:00Z"), record:async(input)=>{recorded=input;return input as any;},
});
assert.equal(recorded.status,"complete");
assert.notEqual(recorded.firstContentFingerprint,recorded.secondContentFingerprint);
let replayReads=0;
const replay=await captureInventoryObservation({requestId:"r1",sellerKey:"seller-a"},{
  begin:async()=>({state:"complete",observation:{id:"1",status:"complete"}} as const),
  getContext:async()=>{replayReads++;return "";},exportInventory:async()=>{replayReads++;return "";},
  now:()=>new Date(),record:async(value)=>value as any,fail:async()=>{},
});
assert.equal(replayReads,0);
assert.equal(replay.id,"1");
console.log("PASS complete inventory observations validate seller, rows, and stable quantity evidence");
