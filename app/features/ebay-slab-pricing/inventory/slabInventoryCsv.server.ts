import Papa from "papaparse";
import {
  parseInventoryImport,
  SlabInventoryError,
  type ListingSnapshot,
} from "./slabInventory";

// Small, explicit interchange format. Item IDs/certificates never pass through numeric CSV inference.
export function parseInventoryCsv(
  csv: string,
  seller: string,
  observedAt = new Date().toISOString(),
) {
  if (Buffer.byteLength(csv) > 2 * 1024 * 1024)
    throw new SlabInventoryError(
      "invalid-input",
      "Inventory CSV must be at most 2 MiB.",
    );
  const result = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  const required = [
    "item_id",
    "title",
    "price",
    "currency",
    "quantity",
    "state",
    "format",
  ];
  if (
    result.errors.length ||
    required.some((name) => !result.meta.fields?.includes(name))
  )
    throw new SlabInventoryError(
      "invalid-input",
      `Provide a valid CSV with columns: ${required.join(", ")}.`,
    );
  const number = (value: string | undefined) =>
    value?.trim() && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const listings = result.data.map((row): ListingSnapshot => ({
    itemId: row.item_id,
    variationKey: row.variation_key ?? "",
    sku: row.sku || null,
    title: row.title,
    price: { amount: number(row.price), currency: row.currency },
    shipping: {
      amount: row.shipping_amount ? number(row.shipping_amount) : null,
      currency: row.shipping_currency || null,
      policyId: row.shipping_policy_id || null,
    },
    quantity: number(row.quantity),
    state: row.state as ListingSnapshot["state"],
    format: row.format as ListingSnapshot["format"],
    certificate:
      row.grader && row.certificate_number
        ? { grader: row.grader, certificateNumber: row.certificate_number }
        : null,
    expected: {
      name: row.card_name,
      set: row.set,
      cardNumber: row.card_number,
      year: row.year,
      language: row.language,
      finish: row.finish,
      edition: row.edition,
      stamp: row.stamp,
      game: row.game,
      gradeLabel: row.grade_label,
      gradeNumber: row.grade_number ? number(row.grade_number) : null,
    },
    specifics: {},
    reviewReasons: [],
  }));
  // Files cannot claim authoritative seller coverage or retire unseen stock.
  return parseInventoryImport({
    seller,
    source: "csv",
    observedAt,
    completeActiveInventory: false,
    listings,
  });
}
