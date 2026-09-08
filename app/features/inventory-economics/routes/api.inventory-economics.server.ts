import { data } from "react-router";
import { inventoryEconomicsRepository } from "~/core/db";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";
import { dollarsToCents } from "../domain/money";
import { loadInventoryEconomicsWorkspace } from "../services/inventoryEconomics.server";
import { importPurchaseCostCsv, MAX_PURCHASE_COST_CSV_BYTES } from "../services/purchaseCostFileImport.server";

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} is invalid.`);
  return value as string[];
}
function parseBatchNumbers(value: unknown): number[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[|;,]/) : [];
  const numbers = values.map((item) => Number(String(item).trim()));
  if (!numbers.length || numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
    throw new Error("Batch numbers must be positive integers.");
  }
  return numbers;
}
function parseExplicitAllocations(value: unknown) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("Explicit allocation requires an amount for every selected receipt.");
  }
  const seen = new Set<number>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Explicit allocation ${index + 1} is invalid.`);
    const allocation = item as Record<string, unknown>;
    const receiptId = Number(allocation.receiptId);
    if (!Number.isInteger(receiptId) || receiptId <= 0 || seen.has(receiptId)) {
      throw new Error("Explicit allocations require unique receipt selections.");
    }
    seen.add(receiptId);
    const amountCents = allocation.amountCents === undefined
      ? dollarsToCents(allocation.amount,`Receipt allocation ${index + 1}`)
      : allocation.amountCents;
    if (!Number.isSafeInteger(amountCents) || (amountCents as number) < 0) {
      throw new Error(`Receipt allocation ${index + 1} must be nonnegative whole cents.`);
    }
    return { receiptId, amountCents:amountCents as number };
  });
}

export function createInventoryEconomicsHandlers(dependencies = {
  getConfig: getShippingExportConfig,
  loadWorkspace: loadInventoryEconomicsWorkspace,
  recordPurchaseCost: inventoryEconomicsRepository.recordPurchaseCost,
  recordFundingAdjustment: inventoryEconomicsRepository.recordFundingAdjustment,
  recordOrderExpense: inventoryEconomicsRepository.recordOrderExpense,
  findPurchaseAllocationTargets: inventoryEconomicsRepository.findPurchaseAllocationTargets,
  importPurchaseCosts: importPurchaseCostCsv,
}) {
  const configuredSeller = async () => {
    const sellerKey = (await dependencies.getConfig()).defaultSellerKey.trim();
    if (!sellerKey) throw new Error("Configure a default shipping seller before recording inventory economics.");
    return sellerKey;
  };
  return {
    loader: async () => {
      try { return data({ workspace: await dependencies.loadWorkspace(await configuredSeller()) }); }
      catch (error) { return data({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
    },
    action: async ({ request }: { request: Request }) => {
      if (request.method !== "POST") return data({ error: "Method not allowed." }, { status: 405 });
      try {
        const sellerKey = await configuredSeller();
        const payload = await request.json() as Record<string, unknown>;
        const requestId = text(payload.requestId, "Request ID");
        const currency = text(payload.currency ?? "USD", "Currency");
        if (payload.action === "find_purchase_allocation_targets") {
          const result = await dependencies.findPurchaseAllocationTargets(sellerKey,parseBatchNumbers(payload.batchNumbers));
          return data({ purchaseAllocationTargets:result.targets,purchaseAllocationTargetsComplete:result.complete });
        }
        if (payload.action === "record_purchase_cost") {
          const allocationRule = choice(payload.allocationRule,["quantity","frozen_market","explicit"] as const,"Allocation rule");
          const result = await dependencies.recordPurchaseCost({
            requestId,sellerKey,currency,
            purchaseReference:text(payload.purchaseReference,"Purchase reference"),
            totalAmountCents:dollarsToCents(payload.totalAmount,"Purchase total"),
            provenance:choice(payload.provenance,["actual","estimated"] as const,"Provenance"),
            source:"manual",allocationRule,
            batchNumbers:parseBatchNumbers(payload.batchNumbers),purchasedAt:optionalText(payload.purchasedAt),
            ...(allocationRule === "frozen_market"
              ? { marketObservedAt:optionalText(payload.marketObservedAt) } : {}),
            correctsEntryId:optionalText(payload.correctsEntryId),
            correctionReason:optionalText(payload.correctionReason),
            ...(allocationRule === "explicit"
              ? { explicitAllocations:parseExplicitAllocations(payload.explicitAllocations) } : {}),
          });
          return data({ result, workspace: await dependencies.loadWorkspace(sellerKey) });
        }
        if (payload.action === "record_funding") {
          const result = await dependencies.recordFundingAdjustment({
            requestId,sellerKey,currency,adjustmentReference:text(payload.adjustmentReference,"Adjustment reference"),
            adjustmentType:choice(payload.adjustmentType,["opening_cash","external_contribution","withdrawal","reserve","reserve_release","purchase_funding"] as const,"Adjustment type"),
            amountCents:dollarsToCents(payload.amount,"Funding amount"),
            provenance:choice(payload.provenance,["actual","estimated"] as const,"Provenance"),
            effectiveAt:text(payload.effectiveAt,"Effective date"),purchaseReference:optionalText(payload.purchaseReference),
            correctsEntryId:optionalText(payload.correctsEntryId),correctionReason:optionalText(payload.correctionReason),
          });
          return data({ result, workspace: await dependencies.loadWorkspace(sellerKey) });
        }
        if (payload.action === "record_expense") {
          const result = await dependencies.recordOrderExpense({
            requestId,sellerKey,currency,expenseReference:text(payload.expenseReference,"Expense reference"),
            expenseType:choice(payload.expenseType,["fulfillment","refund_settlement","other"] as const,"Expense type"),
            amountCents:dollarsToCents(payload.amount,"Expense amount"),
            provenance:choice(payload.provenance,["actual","estimated"] as const,"Provenance"),
            orderNumbers:stringArray(payload.orderNumbers,"Order numbers"),expenseAt:text(payload.expenseAt,"Expense date"),
            basis:choice(payload.basis,["additional_expense","original_net_refund_adjustment","already_adjusted_net"] as const,"Expense basis"),
            correctsEntryId:optionalText(payload.correctsEntryId),correctionReason:optionalText(payload.correctionReason),
          });
          return data({ result, workspace: await dependencies.loadWorkspace(sellerKey) });
        }
        if (payload.action === "import_purchase_costs") {
          const csvText = text(payload.csvText,"Purchase cost CSV");
          if (Buffer.byteLength(csvText,"utf8") > MAX_PURCHASE_COST_CSV_BYTES) return data({ error: "Purchase cost CSV exceeds 256 KB." }, { status: 413 });
          const result = await dependencies.importPurchaseCosts(sellerKey,csvText);
          return data({ result, workspace: await dependencies.loadWorkspace(sellerKey) });
        }
        return data({ error: "Unknown inventory economics action." }, { status: 400 });
      } catch (error) { return data({ error: error instanceof Error ? error.message : String(error) }, { status: 409 }); }
    },
  };
}
