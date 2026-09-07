export type QuantityCommit = {
  sku: number;
  quantity: number;
  expectedQuantity: number;
};

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
