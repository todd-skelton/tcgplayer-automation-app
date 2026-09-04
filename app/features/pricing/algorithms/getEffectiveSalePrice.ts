import type { Sale } from "../../../integrations/tcgplayer/client/get-latest-sales.server";
import { PRICING_CONSTANTS } from "../../../core/constants/pricing";

/**
 * Converts a TCGplayer sale into the historical per-card value used by pricing.
 * The API reports purchase price per card and shipping per order.
 */
export function getEffectiveSalePrice(sale: Sale): number {
  const unitPurchasePrice = sale.purchasePrice ?? 0;
  const shippingPrice = sale.shippingPrice ?? 0;
  const quantity = sale.quantity && sale.quantity > 0 ? sale.quantity : 1;

  // Preserve the application's existing shipping treatment. Below the store's
  // free-shipping threshold, shipping is treated as a basket charge rather than
  // card value.
  const shippingPerUnit =
    unitPurchasePrice >= PRICING_CONSTANTS.FREE_SHIPPING_THRESHOLD
      ? shippingPrice / quantity
      : 0;

  return unitPurchasePrice + shippingPerUnit;
}
