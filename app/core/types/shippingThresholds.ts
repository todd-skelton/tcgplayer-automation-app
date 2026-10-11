/**
 * Order item values where our shipping economics step: under $5 the buyer
 * pays shipping, from $5 shipping is free, from $50 orders ship tracked
 * ground, and from $250 they ship with signature.
 */
export const SHIPPING_THRESHOLDS = [5, 50, 250] as const;

/** Buyer shipping and postage per order for one band of order item value. */
export interface ShippingTier {
  /** Lowest order item value in the tier; the next tier starts where this one ends. */
  fromOrderValue: number;
  /** Mean shipping the buyer paid per order. */
  buyerShipping: number;
  /** Mean postage bought per order. */
  postage: number;
  /** Orders in the evidence window whose item value fell in the tier. */
  orderCount: number;
  /** Of those, orders with purchased postage. */
  postageOrderCount: number;
  /** Observed from recent orders, or the default used when they are too few. */
  basis: "observed" | "default";
}

export interface ShippedOrderLine {
  sku: number;
  quantity: number;
  unitPrice: number;
}

/** An order that was not canceled, with what the buyer paid for shipping and the postage bought. */
export interface ShippedOrder {
  orderNumber: string;
  orderTime: Date;
  itemValue: number;
  /** Shipping the buyer paid, when the order records it. */
  buyerShipping?: number;
  /** Postage bought for the order, when a label is linked to it. */
  postage?: number;
  lines: ShippedOrderLine[];
}

/** One unit sold and the value of everything else the buyer ordered with it. */
export interface BasketEvidence {
  unitPrice: number;
  otherItemsValue: number;
}

/** Shipping economics learned from a trailing window of the seller's own orders. */
export interface ShippingCostModel {
  learnedAt: string;
  evidenceWindowDays: number;
  orderCount: number;
  tiers: ShippingTier[];
  baskets: BasketEvidence[];
}

/** What the profit-per-day policy needs to consider listing just under a threshold. */
export interface ShippingThresholdSnapPolicy {
  thresholds: number[];
  /** A price up to this fraction above a threshold may be snapped just under it. */
  snapRange: number;
  costModel: ShippingCostModel;
}

/**
 * snapped: listed just under the threshold.
 * kept: the snap was considered and the policy price returned more.
 * floor: the snap price was below the price floor.
 */
export type ShippingThresholdSnapOutcome = "snapped" | "kept" | "floor";

/** A snap considered for one pricing decision, recorded so its results can be tracked. */
export interface ShippingThresholdSnap {
  threshold: number;
  outcome: ShippingThresholdSnapOutcome;
  /** Price the policy chose before the snap was considered. */
  policyPrice: number;
  snapPrice: number;
  /** Expected shipping cost per unit (postage less buyer shipping, after fees) at each price. */
  policyPriceShippingCost: number;
  snapPriceShippingCost: number;
  /** Net proceeds after shipping, discounted at the hurdle over the expected sell time. */
  policyPriceReturn: number;
  snapPriceReturn: number;
  costModelLearnedAt: string;
}

/** A published price whose pricing decision considered a shipping threshold snap. */
export interface SnapPublication {
  sku: number;
  publishedAt: Date;
  listedPrice: number;
  snap: ShippingThresholdSnap;
}