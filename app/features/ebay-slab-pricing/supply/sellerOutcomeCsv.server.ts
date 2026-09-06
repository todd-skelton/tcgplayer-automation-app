import Papa from "papaparse";
import { sellerAccount } from "../inventory/slabInventory";
import type { SellerOutcome } from "./supplyContext";
export class SellerOutcomeError extends Error {}
export function parseSellerOutcomeCsv(
  csv: string,
  seller: string,
): Omit<SellerOutcome, "observedAt">[] {
  seller = sellerAccount(seller);
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 256 * 1024)
    throw new SellerOutcomeError("Provide at most 256 KiB of seller outcomes.");
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  if (
    parsed.errors.length ||
    !parsed.data.length ||
    parsed.data.length > 50 ||
    ["event_id", "item_id", "kind", "occurred_at", "quantity", "note"].some(
      (name) => !parsed.meta.fields?.includes(name),
    )
  )
    throw new SellerOutcomeError(
      "Provide 1–50 outcomes with event_id, item_id, kind, occurred_at, quantity and note columns.",
    );
  return parsed.data.map((row, index) => {
    const id = row.event_id.trim(),
      itemId = row.item_id.trim(),
      note = row.note.trim();
    const occurredAt = row.occurred_at.trim(),
      parsedTime = Date.parse(occurredAt);
    const relatedSaleId = row.related_sale_id?.trim() || null,
      nextItemId = row.next_item_id?.trim() || null;
    const priceText = row.price?.trim() || "",
      currency = row.currency?.trim() || "";
    const price = priceText ? { amount: Number(priceText), currency } : null;
    const identifier = (value: string) => /^[\w.:-]{1,120}$/.test(value);
    const item = (value: string) => /^\d{9,15}$/.test(value);
    if (
      !identifier(id) ||
      !item(itemId) ||
      !["sale", "cancellation", "relist"].includes(row.kind) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(occurredAt) ||
      !Number.isFinite(parsedTime) ||
      new Date(parsedTime).toISOString() !==
        occurredAt.replace(/(?<=:\d\d)Z$/, ".000Z") ||
      row.quantity.trim() !== "1" ||
      !note ||
      note.length > 1000 ||
      (price
        ? !/^\d+(?:\.\d{1,2})?$/.test(priceText) ||
          price.amount <= 0 ||
          price.amount >= 1e9 ||
          !/^[A-Z]{3}$/.test(currency)
        : !!currency) ||
      (relatedSaleId !== null &&
        (!identifier(relatedSaleId) || relatedSaleId === id)) ||
      (nextItemId !== null && (!item(nextItemId) || nextItemId === itemId)) ||
      (row.kind === "sale" && (!!relatedSaleId || !!nextItemId)) ||
      (row.kind === "cancellation" &&
        (!relatedSaleId || !!nextItemId || !!price)) ||
      (row.kind === "relist" && (!nextItemId || !!relatedSaleId || !!price))
    )
      throw new SellerOutcomeError(
        `Check outcome row ${index + 2}: use a UTC timestamp, quantity 1, an explicit review note and valid sale/cancellation/relist fields.`,
      );
    return {
      id,
      seller,
      itemId,
      kind: row.kind as SellerOutcome["kind"],
      occurredAt: new Date(parsedTime).toISOString(),
      quantity: 1,
      price,
      relatedSaleId,
      nextItemId,
      source: "reviewed-manual",
      note,
    };
  });
}
