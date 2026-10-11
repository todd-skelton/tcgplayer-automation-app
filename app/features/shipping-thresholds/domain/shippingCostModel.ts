import {
  SHIPPING_THRESHOLDS,
  type BasketEvidence,
  type ShippedOrder,
  type ShippingCostModel,
  type ShippingTier,
} from "~/core/types/shippingThresholds";

type OrderEvidence = Pick<ShippedOrder, "itemValue" | "buyerShipping" | "postage" | "lines">;

/** A tier with fewer orders than this keeps its default. */
export const MINIMUM_TIER_ORDERS = 10;
/** With fewer baskets than this near a threshold, its snap is not considered. */
export const MINIMUM_NEARBY_BASKETS = 20;

/**
 * Per-order values measured from production orders in October 2026. They only
 * stand in for a tier until its recent orders are numerous enough to learn from.
 */
export const DEFAULT_SHIPPING_TIERS: readonly ShippingTier[] = [
  { fromOrderValue: 0, buyerShipping: 1.49, postage: 0.78 },
  { fromOrderValue: SHIPPING_THRESHOLDS[0], buyerShipping: 0, postage: 0.83 },
  { fromOrderValue: SHIPPING_THRESHOLDS[1], buyerShipping: 0, postage: 5.77 },
  { fromOrderValue: SHIPPING_THRESHOLDS[2], buyerShipping: 0, postage: 9.8 },
].map((tier) => ({
  ...tier,
  orderCount: 0,
  postageOrderCount: 0,
  basis: "default" as const,
}));

const toCents = (value: number): number => Math.round(value * 100);
const roundCurrency = (value: number): number => Math.round(value * 100) / 100;
const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function learnTier(
  tier: ShippingTier,
  nextTier: ShippingTier | undefined,
  orders: readonly OrderEvidence[],
): ShippingTier {
  const inTier = orders.filter(
    (order) =>
      toCents(order.itemValue) >= toCents(tier.fromOrderValue) &&
      (!nextTier || toCents(order.itemValue) < toCents(nextTier.fromOrderValue)),
  );
  const buyerShipping = inTier.flatMap((order) =>
    order.buyerShipping === undefined ? [] : [order.buyerShipping],
  );
  const postage = inTier.flatMap((order) =>
    order.postage === undefined ? [] : [order.postage],
  );
  const counts = { orderCount: inTier.length, postageOrderCount: postage.length };
  return buyerShipping.length >= MINIMUM_TIER_ORDERS &&
    postage.length >= MINIMUM_TIER_ORDERS
    ? {
        fromOrderValue: tier.fromOrderValue,
        buyerShipping: roundCurrency(mean(buyerShipping)),
        postage: roundCurrency(mean(postage)),
        ...counts,
        basis: "observed",
      }
    : { ...tier, ...counts };
}

/** Shipping economics per tier and the baskets units sold in, from recent orders. */
export function learnShippingCostModel(
  orders: readonly OrderEvidence[],
  options: { learnedAt: string; evidenceWindowDays: number },
): ShippingCostModel {
  const baskets: BasketEvidence[] = orders.flatMap((order) =>
    order.lines.flatMap(({ quantity, unitPrice }) =>
      Array.from({ length: quantity }, () => ({
        unitPrice,
        otherItemsValue: roundCurrency(Math.max(0, order.itemValue - unitPrice)),
      })),
    ),
  );
  return {
    learnedAt: options.learnedAt,
    evidenceWindowDays: options.evidenceWindowDays,
    orderCount: orders.length,
    tiers: DEFAULT_SHIPPING_TIERS.map((tier, index) =>
      learnTier(tier, DEFAULT_SHIPPING_TIERS[index + 1], orders),
    ),
    baskets,
  };
}

export function tierForOrderValue(
  tiers: readonly ShippingTier[],
  orderValue: number,
): ShippingTier {
  const cents = toCents(orderValue);
  return (
    [...tiers].reverse().find((tier) => cents >= toCents(tier.fromOrderValue)) ??
    tiers[0]
  );
}

/** Postage less the buyer's shipping after fees, for one order; negative is income. */
export function orderShippingCost(
  tiers: readonly ShippingTier[],
  orderValue: number,
  overheadRate: number,
): number {
  if (toCents(orderValue) <= 0) return 0;
  const tier = tierForOrderValue(tiers, orderValue);
  return tier.postage - tier.buyerShipping * (1 - overheadRate);
}

/**
 * Baskets of units sold between half and twice the price. Buyers of cheap
 * and expensive cards order differently, so baskets far from the price are
 * not used in place of missing nearby ones.
 */
export function basketsNear(
  model: ShippingCostModel,
  price: number,
): readonly BasketEvidence[] {
  return model.baskets.filter(
    (basket) => basket.unitPrice >= price / 2 && basket.unitPrice < price * 2,
  );
}

/**
 * Shipping cost one unit at this price adds to the orders it would join: the
 * change in postage less buyer shipping when it is added to each basket.
 */
export function expectedShippingCost(
  tiers: readonly ShippingTier[],
  baskets: readonly BasketEvidence[],
  price: number,
  overheadRate: number,
): number {
  if (baskets.length === 0) return orderShippingCost(tiers, price, overheadRate);
  return mean(
    baskets.map(
      ({ otherItemsValue }) =>
        orderShippingCost(tiers, otherItemsValue + price, overheadRate) -
        orderShippingCost(tiers, otherItemsValue, overheadRate),
    ),
  );
}
