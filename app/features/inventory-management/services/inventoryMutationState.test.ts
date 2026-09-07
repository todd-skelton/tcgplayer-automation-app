import assert from "node:assert/strict";
import { InventoryMutationState } from "./inventoryMutationState";

const state = new InventoryMutationState();
state.started();
const skuA = state.beginSku(1);
state.started();
const skuB = state.beginSku(2);
state.failed();
assert.equal(state.finished(), false);
assert.equal(state.canApplySku(skuA), true);
assert.equal(state.canApplySku(skuB), true);
assert.equal(state.finished(), true, "a failed SKU reloads after the whole queue drains");

const beforeBatch = state.beginSku(1);
const batch = state.beginBarrier();
assert.equal(state.canApplySku(beforeBatch), false);
assert.equal(state.canApplyBarrier(batch), true);
state.beginBarrier();
assert.equal(state.canApplyBarrier(batch), false);

console.log("PASS mutation acknowledgements reconcile cross-SKU failures and barriers");
