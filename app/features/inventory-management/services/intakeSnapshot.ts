export interface IntakeQuantity {
  sku: number;
  quantity: number;
}

export function intakeSnapshot(
  items: readonly IntakeQuantity[],
): IntakeQuantity[] {
  return items
    .map(({ sku, quantity }) => ({ sku, quantity }))
    .sort((left, right) => left.sku - right.sku);
}

export function isIntakeSnapshot(value: unknown): value is IntakeQuantity[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 5000 &&
    value.every(
      (item) =>
        item &&
        Number.isSafeInteger(item.sku) &&
        item.sku > 0 &&
        Number.isSafeInteger(item.quantity) &&
        item.quantity > 0,
    ) &&
    new Set(value.map((item) => item.sku)).size === value.length
  );
}
