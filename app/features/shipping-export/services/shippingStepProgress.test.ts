import assert from "node:assert/strict";
import { describeShippingStep, type ShippingWorkflowCounts } from "./shippingStepProgress";

const counts: ShippingWorkflowCounts = {
  orderCount: 3,
  isLoadingOrders: false,
  itemCount: 7,
  shipmentCount: 2,
  purchasedCount: 1,
  packedCount: 0,
  shipPendingCount: 0,
  shippedCount: 0,
};

assert.deepEqual(describeShippingStep("load-orders", { ...counts, orderCount: 0 }), {
  summary: "No orders loaded",
  readyToContinue: false,
  canSkip: false,
});
assert.equal(describeShippingStep("load-orders", { ...counts, isLoadingOrders: true }).readyToContinue, false);
assert.deepEqual(describeShippingStep("load-orders", counts), {
  summary: "3 orders loaded",
  readyToContinue: true,
  canSkip: false,
});

assert.equal(describeShippingStep("pull-sheet", counts).summary, "7 cards to pull for 3 orders");

assert.deepEqual(describeShippingStep("buy-postage", counts), {
  summary: "Postage bought for 1 of 2 shipments",
  readyToContinue: false,
  canSkip: true,
});
assert.equal(describeShippingStep("buy-postage", { ...counts, purchasedCount: 2 }).readyToContinue, true);
assert.equal(describeShippingStep("buy-postage", { ...counts, shipmentCount: 0, purchasedCount: 0 }).canSkip, false);

assert.equal(describeShippingStep("print", counts).summary, "1 label ready to print");

assert.deepEqual(describeShippingStep("pack", counts), {
  summary: "0 of 2 shipments packed",
  readyToContinue: false,
  canSkip: true,
});
assert.equal(describeShippingStep("pack", { ...counts, packedCount: 1 }).readyToContinue, true);

assert.equal(describeShippingStep("ship", { ...counts, shipPendingCount: 2 }).summary, "2 orders to mark shipped and notify");
assert.equal(
  describeShippingStep("ship", { ...counts, shippedCount: 2 }).summary,
  "Every order is shipped and its buyer notified",
);
assert.equal(describeShippingStep("ship", counts).summary, "No orders have production postage");

console.log("PASS shipping step progress names where each step stands and when it may be continued or skipped");
