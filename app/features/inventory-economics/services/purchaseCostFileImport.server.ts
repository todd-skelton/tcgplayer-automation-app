import { createHash } from "node:crypto";
import { inventoryEconomicsRepository } from "~/core/db";
import { withTransaction } from "~/core/db/database.server";
import { dollarsToCents } from "../domain/money";
import type { PurchaseCostInput } from "../types/inventoryEconomics";

export const MAX_PURCHASE_COST_CSV_BYTES = 256 * 1024;
export const MAX_PURCHASE_COST_CSV_ROWS = 25;
export const PURCHASE_COST_CSV_HEADER = "Purchase Reference,Batch Numbers,Total Amount,Provenance,Allocation Rule,Purchased At,Currency";

function parseDate(value: string, row: number): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`CSV row ${row}: Purchased At must be YYYY-MM-DD or blank.`);
  }
  return value;
}

export function parsePurchaseCostCsv(sellerKey: string, csvText: string): PurchaseCostInput[] {
  if (Buffer.byteLength(csvText,"utf8") > MAX_PURCHASE_COST_CSV_BYTES) throw new Error("Purchase cost CSV exceeds 256 KB.");
  const normalized = csvText.replace(/^\uFEFF/,"").replace(/\r\n/g,"\n").trim();
  const lines = normalized.split("\n").filter((line) => line.trim());
  if (lines.shift()?.trim() !== PURCHASE_COST_CSV_HEADER) throw new Error(`CSV header must be: ${PURCHASE_COST_CSV_HEADER}`);
  if (!lines.length || lines.length > MAX_PURCHASE_COST_CSV_ROWS) throw new Error(`CSV must contain 1 to ${MAX_PURCHASE_COST_CSV_ROWS} rows.`);
  const contentFingerprint = createHash("sha256").update(normalized).digest("hex");
  return lines.map((line,index) => {
    const row = index + 2;
    const columns = line.split(",").map((value) => value.trim());
    if (columns.length !== 7) throw new Error(`CSV row ${row} must contain seven columns.`);
    const batchNumbers = columns[1].split(/[|;]/).map(Number);
    if (!batchNumbers.length || batchNumbers.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw new Error(`CSV row ${row}: Batch Numbers must use positive integers separated by |.`);
    }
    if (!columns[0]) throw new Error(`CSV row ${row}: Purchase Reference is required.`);
    if (columns[3] !== "actual" && columns[3] !== "estimated") throw new Error(`CSV row ${row}: Provenance must be actual or estimated.`);
    if (columns[4] !== "quantity") throw new Error(`CSV row ${row}: File imports support quantity allocation; frozen market weights require manual dated evidence.`);
    if (!/^[A-Z]{3}$/.test(columns[6])) throw new Error(`CSV row ${row}: Currency must be a three-letter uppercase code.`);
    return { requestId:`purchase-cost-import:${contentFingerprint}:${index+1}`,sellerKey,
      purchaseReference:columns[0],batchNumbers,totalAmountCents:dollarsToCents(columns[2],`CSV row ${row}: Total Amount`),
      provenance:columns[3],allocationRule:"quantity",purchasedAt:parseDate(columns[5],row),
      currency:columns[6],source:"file_import" };
  });
}

export async function importPurchaseCostCsv(sellerKey: string, csvText: string) {
  const inputs = parsePurchaseCostCsv(sellerKey,csvText);
  return withTransaction(async (db) => {
    const results = [];
    for (const input of inputs) results.push(await inventoryEconomicsRepository.recordPurchaseCost(input,db));
    return { rows:results.length,repeated:results.every((result) => result.repeated) };
  });
}
