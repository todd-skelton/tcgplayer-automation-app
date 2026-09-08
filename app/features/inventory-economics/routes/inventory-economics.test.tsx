import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryEconomicsOrderTable, InventoryEconomicsStatus, RecentRecords } from "./inventory-economics";
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
  costCoverage:"actual" as const,missing:[] }] };
const markup = renderToStaticMarkup(<InventoryEconomicsOrderTable workspace={success} />);
assert.match(markup,/SYNTHETIC-1/); assert.match(markup,/Realized profit/); assert.match(markup,/actual proceeds/);
console.log("PASS inventory economics UI renders loading, empty, error, and success states");
