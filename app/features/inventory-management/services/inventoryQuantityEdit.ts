export type QuantityCommit = {
  sku: number;
  quantity: number;
  expectedQuantity: number;
};

export type QuantityAdjustment = {
  displayValue: string;
  quantityDelta: number;
};

export function adjustDisplayedQuantity(
  displayValue: string,
  requestedDelta: number,
): QuantityAdjustment {
  const parsed = Number.parseInt(displayValue, 10);
  const startingQuantity = Number.isFinite(parsed)
    ? Math.max(0, parsed)
    : 0;
  const quantity = Math.max(0, startingQuantity + requestedDelta);
  return {
    displayValue: quantity.toString(),
    quantityDelta: quantity - startingQuantity,
  };
}

export function finishQuantityEdit(
  sku: number,
  displayValue: string,
  expectedQuantity: number,
  changed: boolean,
): { displayValue: string; commit: QuantityCommit | null } {
  const parsed = Number.parseInt(displayValue, 10);
  const quantity = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  return {
    displayValue: quantity.toString(),
    commit:
      changed && quantity !== expectedQuantity
        ? { sku, quantity, expectedQuantity }
        : null,
  };
}
