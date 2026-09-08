import assert from "node:assert/strict";
import { parsePurchaseCostCsv, PURCHASE_COST_CSV_HEADER } from "./purchaseCostFileImport.server";

const parsed = parsePurchaseCostCsv("seller", `${PURCHASE_COST_CSV_HEADER}\nP-1,10|11,100.01,actual,quantity,,USD`);
assert.deepEqual(parsed[0]?.batchNumbers,[10,11]); assert.equal(parsed[0]?.totalAmountCents,10001);
assert.equal(parsePurchaseCostCsv("seller", `${PURCHASE_COST_CSV_HEADER}\r\nP-1,10,1.00,actual,quantity,,USD`)[0]?.requestId,
  parsePurchaseCostCsv("seller", `${PURCHASE_COST_CSV_HEADER}\nP-1,10,1.00,actual,quantity,,USD`)[0]?.requestId);
assert.throws(() => parsePurchaseCostCsv("seller", `${PURCHASE_COST_CSV_HEADER}\nP-1,10,1.00,actual,quantity,,USD\nBAD`), /seven columns/);
assert.throws(() => parsePurchaseCostCsv("seller", `${PURCHASE_COST_CSV_HEADER}\nP-1,10,1.00,actual,frozen_market,,USD`), /manual dated evidence/);
console.log("PASS purchase cost files validate every row and derive stable replay identities");
