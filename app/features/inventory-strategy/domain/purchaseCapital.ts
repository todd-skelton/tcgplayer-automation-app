import { allocateAmountCents } from "~/features/inventory-economics/domain/money";

export interface SignedLotCost {
  receiptId: number;
  amountCents: number;
}

export interface PurchaseCapital {
  /** Cash the purchase actually tied up: the netted total, never below zero. */
  totalAmountCents: number;
  /** Capital carried by each lot; lots that cost less than nothing carry none. */
  lotAmountCents: Map<number, number>;
}

/**
 * Turns a purchase's signed lot costs into the capital it tied up. A lot with a
 * negative cost offsets the price of the others, so the netted total is spread
 * over the positive-cost lots in proportion to their cost and negative lots
 * carry no capital. A purchase with only nonnegative lots is unchanged.
 */
export function purchaseCapital(lots: readonly SignedLotCost[]): PurchaseCapital {
  const lotAmountCents = new Map<number, number>();
  const positive = lots.filter((lot) => lot.amountCents > 0);
  const totalAmountCents = Math.max(0, lots.reduce((sum, lot) => sum + lot.amountCents, 0));
  for (const lot of lots) lotAmountCents.set(lot.receiptId, 0);
  if (totalAmountCents > 0) {
    const shares = allocateAmountCents(totalAmountCents,
      positive.map((lot) => ({ id: String(lot.receiptId), weight: lot.amountCents })));
    for (const share of shares) lotAmountCents.set(Number(share.id), share.amountCents);
  }
  return { totalAmountCents, lotAmountCents };
}