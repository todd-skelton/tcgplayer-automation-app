import type {
  ShippingThresholdSnap,
  ShippingThresholdSnapPolicy,
} from "~/core/types/shippingThresholds";
import {
  MINIMUM_NEARBY_BASKETS,
  basketsNear,
  expectedShippingCost,
} from "~/features/shipping-thresholds/domain/shippingCostModel";

export interface ShippingThresholdSnapInputs {
  /** Price the policy chose, after the floor. */
  policyPrice: number;
  snap: ShippingThresholdSnapPolicy;
  dailyReturnHurdle: number;
  /** Share of each sale, buyer shipping included, lost to fees. */
  overheadRate: number;
  /** Net proceeds at a price before shipping. */
  netProceeds: (price: number) => number;
  /** Expected median sell time at a price, when the curve forecasts one. */
  sellDays: (price: number) => number | undefined;
  /** False when a price is below the floor. */
  allowed: (price: number) => boolean;
}

const roundCurrency = (value: number): number => Math.round(value * 100) / 100;

/** The highest threshold the price sits at or within the snap range above. */
export function thresholdToSnapUnder(
  price: number,
  snap: Pick<ShippingThresholdSnapPolicy, "thresholds" | "snapRange">,
): number | undefined {
  return [...snap.thresholds]
    .sort((left, right) => right - left)
    .find(
      (threshold) =>
        price >= threshold && price <= threshold * (1 + snap.snapRange),
    );
}

/**
 * Compares the policy price with one cent under the threshold it sits just
 * above. Each price is valued as net proceeds after its expected shipping
 * cost, discounted at the hurdle over its forecast sell time. Nothing is
 * considered when the price is not near a threshold, either price lacks a
 * forecast, or too few units sold near the threshold to know what buyers
 * order alongside.
 */
export function considerShippingThresholdSnap(
  inputs: ShippingThresholdSnapInputs,
): ShippingThresholdSnap | undefined {
  const { policyPrice, snap } = inputs;
  const threshold = thresholdToSnapUnder(policyPrice, snap);
  if (threshold === undefined) return undefined;
  const snapPrice = roundCurrency(threshold - 0.01);
  const policyDays = inputs.sellDays(policyPrice);
  const snapDays = inputs.sellDays(snapPrice);
  if (policyDays === undefined || snapDays === undefined) return undefined;

  const baskets = basketsNear(snap.costModel, threshold);
  if (baskets.length < MINIMUM_NEARBY_BASKETS) return undefined;
  const shippingCost = (price: number): number =>
    expectedShippingCost(
      snap.costModel.tiers,
      baskets,
      price,
      inputs.overheadRate,
    );
  const discountedReturn = (price: number, days: number): number => {
    const net = inputs.netProceeds(price) - shippingCost(price);
    return net > 0 ? net * Math.exp(-inputs.dailyReturnHurdle * days) : net;
  };
  const policyPriceReturn = discountedReturn(policyPrice, policyDays);
  const snapPriceReturn = discountedReturn(snapPrice, snapDays);
  return {
    threshold,
    outcome: !inputs.allowed(snapPrice)
      ? "floor"
      : snapPriceReturn > policyPriceReturn
        ? "snapped"
        : "kept",
    policyPrice,
    snapPrice,
    policyPriceShippingCost: roundCurrency(shippingCost(policyPrice)),
    snapPriceShippingCost: roundCurrency(shippingCost(snapPrice)),
    policyPriceReturn: roundCurrency(policyPriceReturn),
    snapPriceReturn: roundCurrency(snapPriceReturn),
    costModelLearnedAt: snap.costModel.learnedAt,
  };
}
