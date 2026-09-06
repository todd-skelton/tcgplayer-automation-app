import type { Money, SaleEvidence } from "../evidence/slabEvidence";

export type DatedConversion = {
  from: string;
  to: string;
  rate: number;
  date: string;
  source: string;
};
export type ComparablePrice = {
  reported: Money | null;
  itemOnly: Money | null;
  itemAndShipping: Money | null;
  buyerTotal: Money | null;
  shipping: Money | null;
  fees: Money | null;
  reasons: string[];
};
const valid = (money: Money | null): money is Money =>
  !!money &&
  Number.isFinite(money.amount) &&
  money.amount >= 0 &&
  money.amount < 1e9;
const rounded = (amount: number, currency: string): Money => ({
  amount: Math.round(amount * 1e8) / 1e8,
  currency,
});

// Converted amounts reported by a provider are preserved; this function never invents an FX rate.
export function normalizeSalePrice(
  sale: SaleEvidence,
  currency: string,
  conversion?: DatedConversion,
): ComparablePrice {
  const reasons = new Set<string>();
  const convert = (money: Money | null): Money | null => {
    if (!valid(money)) return null;
    if (money.currency === currency) return money;
    if (
      conversion &&
      money.currency === conversion.from &&
      currency === conversion.to &&
      conversion.date === sale.date &&
      conversion.source.trim() &&
      Number.isFinite(conversion.rate) &&
      conversion.rate > 0
    ) {
      const converted = rounded(money.amount * conversion.rate, currency);
      return valid(converted) ? converted : null;
    }
    return null;
  };
  let reported = convert(sale.price);
  if (
    !reported &&
    !sale.price?.currency &&
    valid(sale.convertedPrice) &&
    sale.convertedPrice.currency === currency
  ) {
    if (valid(sale.price) && sale.price.amount !== sale.convertedPrice.amount)
      reasons.add("provider-conversion-disagrees-with-reported-price");
    else {
      reported = sale.convertedPrice;
      reasons.add("provider-reported-conversion");
    }
  }
  if (!reported) reasons.add("price-currency-unresolved");
  const shipping = convert(sale.shipping),
    fees = convert(sale.fees);
  let itemOnly = reported;
  if (sale.shippingIncluded === null) {
    itemOnly = null;
    reasons.add("shipping-inclusion-unknown");
  }
  if (sale.shippingIncluded === true)
    itemOnly =
      reported && shipping
        ? rounded(reported.amount - shipping.amount, currency)
        : null;
  if (sale.buyerPremiumIncluded === true)
    itemOnly =
      itemOnly && fees
        ? rounded(itemOnly.amount - fees.amount, currency)
        : null;
  if (sale.buyerPremiumIncluded === null) {
    itemOnly = null;
    reasons.add("buyer-premium-inclusion-unknown");
  }
  if (
    sale.kind === "transaction" &&
    sale.quantity !== null &&
    sale.quantity !== 1
  ) {
    itemOnly = null;
    reasons.add("transaction-quantity-price-basis-unresolved");
  }
  if (itemOnly && itemOnly.amount <= 0) {
    itemOnly = null;
    reasons.add("nonpositive-item-price");
  }
  if (!shipping) reasons.add("shipping-unknown");
  if (!fees) reasons.add("buyer-fees-unknown");
  const itemAndShipping =
    itemOnly && shipping
      ? rounded(itemOnly.amount + shipping.amount, currency)
      : null;
  const buyerTotal =
    itemAndShipping && fees && sale.buyerPremiumIncluded !== null
      ? rounded(itemAndShipping.amount + fees.amount, currency)
      : null;
  return {
    reported,
    itemOnly,
    itemAndShipping,
    buyerTotal,
    shipping,
    fees,
    reasons: [...reasons],
  };
}
