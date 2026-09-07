export type ReceiptBalance = {
  receiptId: number;
  quantity: number;
};

export type ReceiptAdjustment = {
  receiptId: number;
  quantityDelta: number;
};

export function reducePendingReceipts(
  receiptsNewestFirst: readonly ReceiptBalance[],
  quantityToRemove: number,
): ReceiptAdjustment[] {
  if (!Number.isInteger(quantityToRemove) || quantityToRemove < 0) {
    throw new Error("Quantity to remove must be a non-negative integer");
  }

  const available = receiptsNewestFirst.reduce(
    (total, receipt) => total + receipt.quantity,
    0,
  );
  if (quantityToRemove > available) {
    throw new Error("Cannot remove more than the pending quantity");
  }

  let remaining = quantityToRemove;
  const adjustments: ReceiptAdjustment[] = [];

  for (const receipt of receiptsNewestFirst) {
    if (remaining === 0) {
      break;
    }

    const removed = Math.min(receipt.quantity, remaining);
    if (removed > 0) {
      adjustments.push({
        receiptId: receipt.receiptId,
        quantityDelta: -removed,
      });
      remaining -= removed;
    }
  }

  return adjustments;
}
