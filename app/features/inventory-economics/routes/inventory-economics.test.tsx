import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InventoryEconomicsOrderTable, InventoryEconomicsStatus, marketInputForRule, marketInstantForCommand, RecentRecords,
} from "./inventory-economics";
import type { InventoryEconomicsWorkspace } from "../types/inventoryEconomics";

assert.match(renderToStaticMarkup(<InventoryEconomicsStatus loading />), /Loading inventory economics/);
assert.match(renderToStaticMarkup(<InventoryEconomicsStatus error="Synthetic load failure" onRetry={() => undefined} />), /Synthetic load failure/);
const empty: InventoryEconomicsWorkspace = { sellerKey:"synthetic-seller",generatedAt:"2026-09-08T00:00:00Z",
  purchaseCosts:[],fundingAdjustments:[],orderExpenses:[],orders:[],uncostedBatches:[] };
assert.match(renderToStaticMarkup(<InventoryEconomicsOrderTable workspace={empty} />), /No captured seller orders yet/);
assert.match(renderToStaticMarkup(<RecentRecords title="Funding adjustments" empty="No funding adjustments." rows={[]} />), /No funding adjustments/);
const success = { ...empty,orders:[{ orderNumber:"SYNTHETIC-1",currency:"USD",grossItemCents:1000,
  grossOrderCents:1000,providerNetCents:900,postageCents:100,otherExpenseCents:0,acquisitionCostCents:400,
  reusableCashCents:800,realizedProfitCents:400,proceedsCoverage:"actual" as const,expenseCoverage:"actual" as const,
  costCoverage:"actual" as const,missing:[],orderedQuantity:1,settledQuantity:1,costKnownQuantity:1 }] };
const markup = renderToStaticMarkup(<InventoryEconomicsOrderTable workspace={success} />);
assert.match(markup,/SYNTHETIC-1/); assert.match(markup,/Realized profit/); assert.match(markup,/actual proceeds/);
assert.match(markup,/1 ordered, 1 settled, 1 cost known/);
const historyMarkup = renderToStaticMarkup(<RecentRecords title="Purchase costs" empty="None" rows={[
  {key:"2",primary:"Invoice version 2",secondary:"current",correct:()=>undefined,
    historyCount:2,historyComplete:true,
    history:[{key:"1",primary:"Invoice version 1",secondary:"superseded; correction reason"}]},
]} />);
assert.equal((historyMarkup.match(/>Correct</g) ?? []).length,1);
assert.match(historyMarkup,/version 1/);
assert.match(historyMarkup,/View correction history \(2 versions\)/);
const localMarketInstant = "2026-08-02T12:00";
const serializedMarketInstant = marketInstantForCommand("frozen_market",localMarketInstant);
assert.equal(new Date(serializedMarketInstant!).getHours(),12);
assert.equal(marketInstantForCommand("quantity",localMarketInstant),undefined);
assert.equal(marketInputForRule("quantity",localMarketInstant),"");
assert.equal(marketInputForRule("explicit",localMarketInstant),"");
assert.equal(marketInputForRule("frozen_market",localMarketInstant),localMarketInstant);
console.log("PASS inventory economics UI renders states, independent coverage, and correction history");
