import type { PurchaseCostInput } from "../types/inventoryEconomics";

export type PurchaseCostDetailsInput = Omit<PurchaseCostInput,"batchNumbers" | "explicitAllocations">;
export type NormalizedPurchaseCostDetails = PurchaseCostDetailsInput;

function requiredText(value: unknown,label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`${label} is required and limited to 200 characters.`);
  }
  return normalized;
}

function optionalText(value: unknown,label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 200) throw new Error(`${label} is limited to 200 characters.`);
  return normalized;
}

function calendarDate(value: unknown): string | undefined {
  const normalized = optionalText(value,"Purchase date");
  if (normalized === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new Error("Purchase date must be a calendar date in YYYY-MM-DD format.");
  const [,year,month,day] = match.map(Number);
  const date = new Date(Date.UTC(year,month-1,day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month-1 || date.getUTCDate() !== day) {
    throw new Error("Purchase date must be a calendar date in YYYY-MM-DD format.");
  }
  return normalized;
}

function instant(value: unknown): string | undefined {
  const normalized = optionalText(value,"Market evidence instant");
  if (normalized === undefined) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error("Market evidence instant must be an ISO timestamp with a UTC offset.");
  }
  return new Date(normalized).toISOString();
}

export function normalizePurchaseCostDetails(input: Record<string,unknown>): NormalizedPurchaseCostDetails {
  const currency = requiredText(input.currency,"Currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter code.");
  if (!Number.isSafeInteger(input.totalAmountCents) || (input.totalAmountCents as number) < 0) {
    throw new Error("Purchase total must be nonnegative whole cents.");
  }
  if (input.provenance !== "actual" && input.provenance !== "estimated") {
    throw new Error("Purchase provenance is invalid.");
  }
  if (input.source !== "intake" && input.source !== "manual" && input.source !== "file_import") {
    throw new Error("Purchase source is invalid.");
  }
  const purchasedAt = calendarDate(input.purchasedAt);
  if (input.allocationRule !== "quantity" && input.allocationRule !== "frozen_market" &&
      input.allocationRule !== "explicit") {
    throw new Error("Purchase allocation rule is invalid.");
  }
  const marketObservedAt = instant(input.marketObservedAt);
  if ((input.allocationRule === "frozen_market") !== (marketObservedAt !== undefined)) {
    throw new Error("Frozen market allocation requires a market evidence instant.");
  }
  const correctsEntryId = optionalText(input.correctsEntryId,"Corrected entry");
  const correctionReason = optionalText(input.correctionReason,"Correction reason");
  if ((correctsEntryId === undefined) !== (correctionReason === undefined)) {
    throw new Error("A correction requires both the current entry and a reason.");
  }
  return {
    requestId:requiredText(input.requestId,"Request ID"),
    sellerKey:requiredText(input.sellerKey,"Seller key"),
    purchaseReference:requiredText(input.purchaseReference,"Purchase reference"),
    currency,
    totalAmountCents:input.totalAmountCents as number,
    provenance:input.provenance,
    source:input.source,
    allocationRule:input.allocationRule,
    ...(purchasedAt !== undefined ? { purchasedAt } : {}),
    ...(marketObservedAt ? { marketObservedAt } : {}),
    ...(correctsEntryId ? { correctsEntryId,correctionReason:correctionReason! } : {}),
  };
}
