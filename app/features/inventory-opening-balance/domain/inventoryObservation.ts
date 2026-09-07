import { createHash } from "node:crypto";
import Papa from "papaparse";

export type InventoryObservationItem = {
  sku: number; quantity: number; productLine: string; setName: string;
  productName: string; condition: string; variant: string;
};

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_DATABASE_INTEGER = 2_147_483_647;

export function validateSellerPricingContext(html: string, expectedSellerKey: string): number {
  const keys = [...html.matchAll(/(["']?sellerKey["']?)\s*[:=]\s*["']([^"']+)["']/gi)]
    .map((match) => match[2]?.trim()).filter((value): value is string => Boolean(value));
  if (keys.length < 2) throw new Error("Seller Portal context did not contain the verified seller identity declarations.");
  if (keys.some((key) => key !== expectedSellerKey.trim())) {
    throw new Error("Seller Portal context does not match the expected seller key.");
  }
  return keys.length;
}

export function parseCompleteInventoryExport(csv: string): InventoryObservationItem[] {
  if (Buffer.byteLength(csv, "utf8") > MAX_BYTES) throw new Error("Inventory export exceeds 8 MB.");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: "greedy" });
  if (parsed.errors.length) throw new Error(`Inventory export is malformed: ${parsed.errors[0]?.message}`);
  if (parsed.data.length > MAX_ROWS) throw new Error("Inventory export exceeds 50,000 rows.");
  const required = ["TCGplayer Id", "Total Quantity", "Product Line", "Set Name", "Product Name", "Condition"];
  for (const column of required) if (!parsed.meta.fields?.includes(column)) throw new Error(`Inventory export is missing ${column}.`);
  const seen = new Set<number>();
  const items = parsed.data.map((row, index) => {
    const sku = Number(row["TCGplayer Id"]);
    const quantityText = row["Total Quantity"]?.trim();
    const quantity = Number(quantityText);
    if (!Number.isInteger(sku) || sku <= 0 || sku > MAX_DATABASE_INTEGER || !/^\d+$/.test(quantityText ?? "") ||
        !Number.isInteger(quantity) || quantity > MAX_DATABASE_INTEGER) {
      throw new Error(`Inventory export row ${index + 2} has an invalid SKU or quantity.`);
    }
    if (seen.has(sku)) throw new Error(`Inventory export repeats SKU ${sku}.`);
    seen.add(sku);
    return {
      sku, quantity,
      productLine: row["Product Line"]?.trim() ?? "",
      setName: row["Set Name"]?.trim() ?? "",
      productName: row["Product Name"]?.trim() ?? "",
      condition: row.Condition?.trim() ?? "",
      variant: row["Printing"]?.trim() ?? row["Sku Variant"]?.trim() ?? "",
    };
  }).sort((a, b) => a.sku - b.sku);
  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity > MAX_DATABASE_INTEGER) {
    throw new Error("Inventory export total quantity exceeds the supported range.");
  }
  return items;
}

export function quantityFingerprint(items: InventoryObservationItem[]): string {
  return createHash("sha256").update(JSON.stringify(items.map(({ sku, quantity }) => [sku, quantity]))).digest("hex");
}

export function contentFingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
