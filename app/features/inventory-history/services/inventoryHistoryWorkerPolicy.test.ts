import assert from "node:assert/strict";
import { inventoryHistoryWorkerEnabled } from "./inventoryHistoryWorkerPolicy";

assert.equal(inventoryHistoryWorkerEnabled(undefined), true);
assert.equal(inventoryHistoryWorkerEnabled("true"), true);
assert.equal(inventoryHistoryWorkerEnabled(" false "), false);
assert.equal(inventoryHistoryWorkerEnabled("0"), false);

console.log("PASS inventory history worker defaults on and supports an explicit operational pause");
