import { dollarsToCents } from "~/features/inventory-economics/domain/money";
import { normalizePurchaseCostDetails } from "~/features/inventory-economics/domain/purchaseCostDetails";

export function parseIntakePurchaseCost(
  value: Record<string, unknown>,
  requestId: string,
  sellerKey: string,
) {
  if (value.allocationRule !== "quantity")
    throw new Error("Intake purchase cost supports quantity allocation.");
  return normalizePurchaseCostDetails({
    requestId: `${requestId}:purchase-cost`,
    sellerKey,
    purchaseReference: value.purchaseReference,
    currency: value.currency === undefined ? "USD" : value.currency,
    totalAmountCents: dollarsToCents(value.totalAmount, "Purchase total"),
    provenance: value.provenance,
    source: "intake",
    allocationRule: "quantity",
    purchasedAt: value.purchasedAt,
  });
}
