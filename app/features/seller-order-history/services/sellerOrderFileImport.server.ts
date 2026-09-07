import { createHash } from "node:crypto";
import Papa from "papaparse";
import { sellerOrderHistoryRepository } from "~/core/db";
import {
  fingerprintSellerOrder,
  normalizeSellerOrderLifecycle,
} from "../domain/sellerOrderObservation";
import type {
  SellerOrderLineEvidence,
  SellerOrderObservation,
  SellerOrderRefundEvidence,
} from "../types/sellerOrderHistory";

const REQUIRED_COLUMNS = [
  "Order Number",
  "Order Time",
  "Status",
  "SKU ID",
  "Quantity",
  "Gross Item Proceeds USD",
] as const;

export const MAX_SELLER_ORDER_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_SELLER_ORDER_CSV_ROWS = 50_000;

function requiredText(row: Record<string, string>, column: string, rowNumber: number): string {
  const value = row[column]?.trim();
  if (!value) throw new Error(`Row ${rowNumber}: ${column} is required.`);
  return value;
}

function parseOffsetTimestamp(value: string, label: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp with Z or a numeric UTC offset.`);
  }
  return new Date(value).toISOString();
}

function parsePositiveInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function parseMoney(value: string, label: string, allowNegative = false): number {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`${label} must be a USD amount with at most two decimal places.`);
  }
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error(`${label} is outside the supported range.`);
  if (!allowNegative && cents < 0) throw new Error(`${label} cannot be negative.`);
  return cents / 100;
}

function refundFromRow(row: Record<string, string>, rowNumber: number): SellerOrderRefundEvidence | null {
  const type = row["Refund Type"]?.trim();
  const createdAt = row["Refund Created At"]?.trim();
  const amount = row["Refund Amount USD"]?.trim();
  const origin = row["Refund Origin"]?.trim();
  if (!type && !createdAt && !amount && !origin) return null;
  return {
    ...(type ? { type } : {}),
    ...(createdAt ? { createdAt: parseOffsetTimestamp(createdAt, `Row ${rowNumber}: Refund Created At`) } : {}),
    ...(amount ? { amount: parseMoney(amount, `Row ${rowNumber}: Refund Amount USD`, true) } : {}),
    ...(origin ? { origin } : {}),
  };
}

export function parseSellerOrderCsv(
  sellerKey: string,
  csvText: string,
  observedAt = new Date().toISOString(),
): SellerOrderObservation[] {
  const normalizedSellerKey = sellerKey.trim();
  if (!normalizedSellerKey) throw new Error("Seller key is required.");
  if (Buffer.byteLength(csvText, "utf8") > MAX_SELLER_ORDER_CSV_BYTES) {
    throw new Error("Seller order CSV exceeds the 5 MB limit.");
  }
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (value) => value.trim(),
  });
  if (parsed.errors.length > 0) throw new Error(`CSV could not be parsed: ${parsed.errors[0]?.message}`);
  if (parsed.data.length > MAX_SELLER_ORDER_CSV_ROWS) {
    throw new Error(`Seller order CSV exceeds the ${MAX_SELLER_ORDER_CSV_ROWS} row limit.`);
  }
  const fields = new Set(parsed.meta.fields ?? []);
  for (const required of REQUIRED_COLUMNS) {
    if (!fields.has(required)) throw new Error(`CSV is missing required column: ${required}.`);
  }
  const grouped = new Map<string, {
    orderTime: string; status: string; summaryOrderTime?: string;
    orderChannel?: string; orderFulfillment?: string; refundStatus?: string;
    lines: SellerOrderLineEvidence[]; refunds: SellerOrderRefundEvidence[];
  }>();
  parsed.data.forEach((row, index) => {
    const rowNumber = index + 2;
    const orderNumber = requiredText(row, "Order Number", rowNumber);
    const orderTime = parseOffsetTimestamp(
      requiredText(row, "Order Time", rowNumber),
      `Row ${rowNumber}: Order Time`,
    );
    const status = requiredText(row, "Status", rowNumber);
    const skuId = requiredText(row, "SKU ID", rowNumber);
    const quantity = parsePositiveInteger(requiredText(row, "Quantity", rowNumber), `Row ${rowNumber}: Quantity`);
    const proceeds = parseMoney(requiredText(row, "Gross Item Proceeds USD", rowNumber), `Row ${rowNumber}: Gross Item Proceeds USD`);
    const currency = row.Currency?.trim() || "USD";
    if (currency !== "USD") throw new Error(`Row ${rowNumber}: Currency must be USD.`);
    const existing = grouped.get(orderNumber);
    if (existing && (existing.orderTime !== orderTime || existing.status !== status)) {
      throw new Error(`Rows for order ${orderNumber} disagree on Order Time or Status.`);
    }
    const order = existing ?? {
      orderTime,
      status,
      ...(row["Summary Order Time"]?.trim()
        ? { summaryOrderTime: parseOffsetTimestamp(row["Summary Order Time"].trim(), `Row ${rowNumber}: Summary Order Time`) }
        : {}),
      ...(row["Order Channel"]?.trim() ? { orderChannel: row["Order Channel"].trim() } : {}),
      ...(row["Order Fulfillment"]?.trim() ? { orderFulfillment: row["Order Fulfillment"].trim() } : {}),
      ...(row["Refund Status"]?.trim() ? { refundStatus: row["Refund Status"].trim() } : {}),
      lines: [],
      refunds: [],
    };
    order.lines.push({
      name: row["Product Name"]?.trim() ?? "",
      unitPrice: Math.round((proceeds / quantity) * 100) / 100,
      extendedPrice: proceeds,
      quantity,
      productId: row["Product ID"]?.trim() ?? "",
      skuId,
    });
    const refund = refundFromRow(row, rowNumber);
    if (refund && !order.refunds.some((value) => JSON.stringify(value) === JSON.stringify(refund))) {
      order.refunds.push(refund);
    }
    grouped.set(orderNumber, order);
  });
  return [...grouped.entries()].map(([orderNumber, order]) => {
    const base = {
      sellerKey: normalizedSellerKey,
      orderNumber,
      orderTime: order.orderTime,
      ...(order.summaryOrderTime ? { summaryOrderTime: order.summaryOrderTime } : {}),
      providerStatus: order.status,
      lifecycle: normalizeSellerOrderLifecycle(order.status),
      ...(order.refundStatus ? { refundStatus: order.refundStatus } : {}),
      ...(order.orderChannel ? { orderChannel: order.orderChannel } : {}),
      ...(order.orderFulfillment ? { orderFulfillment: order.orderFulfillment } : {}),
      grossItemProceeds: Math.round(order.lines.reduce((sum, line) => sum + line.extendedPrice, 0) * 100) / 100,
      lines: order.lines,
      refunds: order.refunds,
      source: "file_import" as const,
    };
    return { ...base, observedAt, fingerprint: fingerprintSellerOrder(base) };
  });
}

export async function importSellerOrderCsv(input: {
  sellerKey: string;
  csvText: string;
  fileName?: string;
}) {
  const fingerprint = createHash("sha256").update(input.csvText).digest("hex");
  const observations = parseSellerOrderCsv(input.sellerKey, input.csvText);
  let importedOrders = 0;
  for (const observation of observations) {
    const result = await sellerOrderHistoryRepository.recordObservation(observation);
    if (result.changed) importedOrders += 1;
  }
  const recorded = await sellerOrderHistoryRepository.recordImport({
    sellerKey: input.sellerKey.trim(), fingerprint, fileName: input.fileName,
    orderCount: observations.length,
    lineCount: observations.reduce((sum, order) => sum + order.lines.length, 0),
  });
  return {
    importedOrders,
    skippedOrders: observations.length - importedOrders,
    totalOrders: observations.length,
    duplicateFile: !recorded,
  };
}
