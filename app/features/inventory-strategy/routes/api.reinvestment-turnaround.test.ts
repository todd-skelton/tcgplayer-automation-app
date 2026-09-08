import assert from "node:assert/strict";
import { createReinvestmentTurnaroundLoader } from "./api.reinvestment-turnaround.server";

let observed:{seller:string;asOf:Date|undefined}|undefined;
const loader=createReinvestmentTurnaroundLoader({findSellerKey:async()=>"synthetic-api",load:async(seller,asOf)=>{
  observed={seller,asOf}; return {sellerKey:seller,asOf:(asOf??new Date(0)).toISOString()} as never;
}});
const response=await loader({request:new Request("http://local/api/inventory-reinvestment-turnaround?asOf=2026-01-21T00:00:00.000Z")} as never);
assert.ok(response);
assert.equal(observed?.seller,"synthetic-api");
assert.equal(observed?.asOf?.toISOString(),"2026-01-21T00:00:00.000Z");
const invalid=await loader({request:new Request("http://local/api/inventory-reinvestment-turnaround?asOf=nope")} as never);
assert.equal((invalid as unknown as {init?:ResponseInit}).init?.status,400);
console.log("PASS reinvestment turnaround API binds the configured seller and validates exact as-of timestamps");
