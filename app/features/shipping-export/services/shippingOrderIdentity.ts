import type { OrderLineItem } from "../types/shippingExport";

/** Exact provider inventory identity used by both ledger attachment and display math. */
export function shippingInventorySkuId(line: Pick<OrderLineItem, "inventorySkuId" | "skuId">): string | null {
  if (line.inventorySkuId?.trim()) return line.inventorySkuId.trim();
  return line.skuId === undefined ? null : String(line.skuId);
}
