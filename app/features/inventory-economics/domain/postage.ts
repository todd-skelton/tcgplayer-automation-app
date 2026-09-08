import { allocateAmountCents } from "./money";

export interface PostageEvidence {
  providerIdentity: string;
  orderNumbers: string[];
  currency: string | null;
  rateCents: number | null;
  linkedSellers: string[];
  linkedOrderCount: number;
}

export function allocatePurchasedPostage(
  sellerKey: string,
  currency: string,
  records: readonly PostageEvidence[],
): Map<string, number> {
  const byProviderIdentity = new Map<string, PostageEvidence>();
  for (const record of records) {
    const existing = byProviderIdentity.get(record.providerIdentity);
    if (!existing) byProviderIdentity.set(record.providerIdentity, record);
  }
  const byOrder = new Map<string, number>();
  for (const record of byProviderIdentity.values()) {
    const orders = [...new Set(record.orderNumbers.map((value) => value.trim()).filter(Boolean))].sort();
    if (!orders.length || record.linkedOrderCount !== orders.length ||
        record.linkedSellers.length !== 1 || record.linkedSellers[0] !== sellerKey ||
        record.currency !== currency || record.rateCents === null ||
        !Number.isSafeInteger(record.rateCents) || record.rateCents < 0) continue;
    for (const allocation of allocateAmountCents(
      record.rateCents,
      orders.map((orderNumber) => ({ id: orderNumber, weight: 1 })),
    )) {
      byOrder.set(allocation.id, (byOrder.get(allocation.id) ?? 0) + allocation.amountCents);
    }
  }
  return byOrder;
}
