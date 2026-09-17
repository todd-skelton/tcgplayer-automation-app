import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InventoryEconomicsOrderTable, InventoryEconomicsStatus, PurchaseCostRecords,
} from "./inventory-economics";
import type { InventoryEconomicsWorkspace, PurchaseCostSummary } from "../types/inventoryEconomics";

assert.match(renderToStaticMarkup(<InventoryEconomicsStatus loading />), /Loading inventory economics/);
assert.match(renderToStaticMarkup(<InventoryEconomicsStatus error="Synthetic load failure" onRetry={() => undefined} />), /Synthetic load failure/);
const empty: InventoryEconomicsWorkspace = { sellerKey:"synthetic-seller",generatedAt:"2026-09-08T00:00:00Z",
  purchaseCosts:[],fundingAdjustments:[],orderExpenses:[],orders:[] };
assert.match(renderToStaticMarkup(<InventoryEconomicsOrderTable workspace={empty} />), /No captured seller orders yet/);
assert.match(renderToStaticMarkup(<PurchaseCostRecords records={[]} />), /No purchase cost records/);
const success = { ...empty,orders:[{ orderNumber:"SYNTHETIC-1",currency:"USD",grossItemCents:1000,
  grossOrderCents:1000,providerNetCents:900,postageCents:100,otherExpenseCents:0,acquisitionCostCents:400,
  reusableCashCents:800,realizedProfitCents:400,proceedsCoverage:"actual" as const,expenseCoverage:"actual" as const,
  costCoverage:"actual" as const,missing:[],orderedQuantity:1,settledQuantity:1,costKnownQuantity:1 }] };
const markup = renderToStaticMarkup(<InventoryEconomicsOrderTable workspace={success} />);
assert.match(markup,/SYNTHETIC-1/); assert.match(markup,/Realized profit/); assert.match(markup,/actual proceeds/);
assert.match(markup,/1 ordered, 1 settled, 1 cost known/);
const record = { id:"1",version:1,isCurrent:true,historyCount:1,historyComplete:true,purchaseReference:"batch-7",
  batchNumbers:[7],totalAmountCents:12345,currency:"USD",source:"market_rate_estimate",provenance:"estimated",
  allocationRule:"frozen_market",purchasedAt:"2026-08-05",evidenceIdentity:"synthetic-evidence" } as unknown as PurchaseCostSummary;
const recordMarkup = renderToStaticMarkup(<PurchaseCostRecords records={[record]} />);
assert.match(recordMarkup,/batch-7: \$123\.45/);
assert.match(recordMarkup,/market rate estimate; estimated; frozen market; batches 7; 2026-08-05/);
console.log("PASS inventory economics UI renders states, purchase cost records, and order coverage");
