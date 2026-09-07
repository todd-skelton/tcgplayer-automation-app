import assert from "node:assert/strict";
import { allocateInventoryFifo, type FifoSupplyLot } from "./allocateInventoryFifo";

const sale="2026-09-07T00:00:00.000Z";
const lot=(value:Partial<FifoSupplyLot>&Pick<FifoSupplyLot,"supplyKey"|"receiptId"|"quantity">):FifoSupplyLot=>({
  dispositionId:null,availableAt:"2026-01-01T00:00:00.000Z",fifoPrecedence:1,
  intakeAt:"2026-01-01T00:00:00.000Z",marketValueTenThousandths:null,...value,
});
const weighted=allocateInventoryFifo([{lineKey:"sale",orderId:"1",orderNumber:"A",orderTime:sale,quantity:3}],[
  lot({supplyKey:"r1",receiptId:1,quantity:2,intakeAt:"2026-07-09T00:00:00.000Z",marketValueTenThousandths:40_000}),
  lot({supplyKey:"r2",receiptId:2,quantity:1,intakeAt:"2026-08-28T00:00:00.000Z",marketValueTenThousandths:60_000}),
])[0]!;
assert.equal(weighted.intakeMarketTotalCents,1400);
assert.equal(Number(weighted.weightedDaysHeld?.toFixed(1)),43.3);
assert.equal(weighted.matchedQuantity,3);

const split=allocateInventoryFifo([
  {lineKey:"later",orderId:"3",orderNumber:"B",orderTime:sale,quantity:2},
  {lineKey:"earlier",orderId:"2",orderNumber:"A",orderTime:"2026-09-06T00:00:00.000Z",quantity:2},
],[
  lot({supplyKey:"opening",receiptId:1,quantity:1,fifoPrecedence:0,intakeAt:null}),
  lot({supplyKey:"known",receiptId:2,quantity:2,marketValueTenThousandths:40_000}),
  lot({supplyKey:"future",receiptId:3,quantity:5,availableAt:"2026-09-08T00:00:00.000Z"}),
]);
assert.deepEqual(split.map((line)=>[line.lineKey,line.matchedQuantity,line.unmatchedQuantity]),[
  ["earlier",2,0],["later",1,1],
]);
assert.equal(split[0]?.allocations[0]?.supplyKey,"opening");
assert.equal(split[0]?.dateKnownQuantity,1);
assert.equal(split[0]?.priceKnownQuantity,1);

const precise=allocateInventoryFifo([
  {lineKey:"fractional",orderId:"4",orderNumber:"C",orderTime:sale,quantity:100},
  {lineKey:"zero",orderId:"5",orderNumber:"D",orderTime:sale,quantity:1},
],[
  lot({supplyKey:"fractional",receiptId:4,quantity:100,marketValueTenThousandths:12_345}),
  lot({supplyKey:"zero",receiptId:5,quantity:1,marketValueTenThousandths:0}),
]);
assert.equal(precise[0]?.intakeMarketTotalCents,12_345);
assert.equal(precise[0]?.priceKnownQuantity,100);
assert.equal(precise[1]?.intakeMarketTotalCents,0);
assert.equal(precise[1]?.priceKnownQuantity,1);
assert.throws(()=>allocateInventoryFifo([
  {lineKey:"bad-time",orderId:"6",orderNumber:"E",orderTime:"2026-09-07T00:00:00",quantity:1},
],[]),/UTC offset/);

const volume=20_000;
const many=allocateInventoryFifo(Array.from({length:volume},(_,index)=>({
  lineKey:`line-${index}`,orderId:String(index+1),orderNumber:String(index).padStart(8,"0"),
  orderTime:"2026-09-07T00:00:00-05:00",quantity:1,
})),Array.from({length:volume},(_,index)=>lot({
  supplyKey:`lot-${index}`,receiptId:index+10,quantity:1,
  availableAt:"2026-09-07T04:59:59.000Z",intakeAt:null,
})));
assert.equal(many.length,volume);
assert.equal(many.reduce((sum,line)=>sum+line.matchedQuantity,0),volume);

console.log("PASS deterministic FIFO splits eligible lots with independent coverage and linearithmic replay");
