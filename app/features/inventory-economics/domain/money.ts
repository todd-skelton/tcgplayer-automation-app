import type { AllocatedAmount, WeightedAmountTarget } from "../types/inventoryEconomics";

export function dollarsToCents(value: unknown, label = "Amount"): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new Error(`${label} must be a nonnegative amount with at most two decimal places.`);
  }
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error(`${label} is outside the supported range.`);
  return cents;
}

export function assertCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value.trim())) {
    throw new Error("Currency must be a three-letter uppercase code.");
  }
  return value.trim();
}

export function allocateAmountCents(
  totalAmountCents: number,
  targets: readonly WeightedAmountTarget[],
): AllocatedAmount[] {
  if (!Number.isSafeInteger(totalAmountCents) || totalAmountCents < 0) {
    throw new Error("Total amount must be nonnegative whole cents.");
  }
  if (targets.length === 0) throw new Error("At least one allocation target is required.");
  const normalized = targets.map((target) => {
    if (!target.id.trim()) throw new Error("Allocation target ID is required.");
    if (!Number.isFinite(target.weight) || target.weight < 0) {
      throw new Error(`Allocation weight for ${target.id} must be nonnegative.`);
    }
    return { ...target, id: target.id.trim() };
  });
  if (new Set(normalized.map((target) => target.id)).size !== normalized.length) {
    throw new Error("Allocation target IDs must be unique.");
  }
  const exactWeights = normalized.map((target) => ({ id: target.id, weight: decimalNumberAsInteger(target.weight) }));
  const scale = exactWeights.reduce((largest, target) => Math.max(largest, target.weight.scale), 0);
  const commonWeights = exactWeights.map((target) => ({
    id: target.id,
    weight: target.weight.integer * 10n ** BigInt(scale - target.weight.scale),
  }));
  const totalWeight = commonWeights.reduce((sum, target) => sum + target.weight, 0n);
  if (totalWeight <= 0n) throw new Error("Allocation weights must include a positive value.");

  const shares = commonWeights.map((target) => {
    const numerator = BigInt(totalAmountCents) * target.weight;
    return { id: target.id, amountCents: numerator / totalWeight, remainder: numerator % totalWeight };
  });
  let remaining = BigInt(totalAmountCents) - shares.reduce((sum, share) => sum + share.amountCents, 0n);
  const remainderOrder = [...shares].sort(
    (left, right) => right.remainder > left.remainder ? 1
      : right.remainder < left.remainder ? -1 : left.id.localeCompare(right.id),
  );
  for (let index = 0; remaining > 0n; index += 1, remaining -= 1n) {
    remainderOrder[index % remainderOrder.length].amountCents += 1n;
  }
  return shares
    .map(({ id, amountCents }) => ({ id, amountCents: Number(amountCents) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function decimalNumberAsInteger(value: number): { integer: bigint; scale: number } {
  const [coefficient, rawExponent = "0"] = value.toString().toLowerCase().split("e");
  const exponent = Number(rawExponent);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  const scale = fraction.length - exponent;
  return scale >= 0
    ? { integer: BigInt(digits), scale }
    : { integer: BigInt(digits) * 10n ** BigInt(-scale), scale: 0 };
}
