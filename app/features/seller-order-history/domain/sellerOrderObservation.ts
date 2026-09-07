import { createHash } from "node:crypto";
import type { SellerOrderDetail } from "~/integrations/tcgplayer/client/get-seller-order.server";
import type { SellerOrderSearchSummary } from "~/integrations/tcgplayer/client/search-seller-orders.server";
import type {
  SellerOrderLifecycle,
  SellerOrderLineEvidence,
  SellerOrderObservation,
  SellerOrderRefundEvidence,
} from "../types/sellerOrderHistory";

export function normalizeSellerOrderLifecycle(status: string): SellerOrderLifecycle {
  switch (status.trim().replace(/\s+/g, " ").toLowerCase()) {
    case "processing": return "processing";
    case "ready to ship":
    case "readytoship": return "ready_to_ship";
    case "shipped - in transit": return "shipped_in_transit";
    case "shipped - delivered": return "shipped_delivered";
    case "completed - paid": return "completed_paid";
    case "canceled":
    case "cancelled": return "canceled";
    default: return "unknown";
  }
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function aggregateSellerOrderLines(
  lines: readonly SellerOrderLineEvidence[],
): SellerOrderLineEvidence[] {
  const bySku = new Map<string, SellerOrderLineEvidence>();
  for (const line of lines) {
    const skuId = line.skuId.trim();
    if (!skuId) throw new Error("Seller order line is missing skuId.");
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`Seller order ${skuId} has an invalid quantity.`);
    }
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0 ||
        !Number.isFinite(line.extendedPrice) || line.extendedPrice < 0) {
      throw new Error(`Seller order ${skuId} has an invalid price.`);
    }
    const previous = bySku.get(skuId);
    if (previous && previous.productId && line.productId && previous.productId !== line.productId) {
      throw new Error(`Seller order SKU ${skuId} has conflicting product IDs.`);
    }
    bySku.set(skuId, previous
      ? {
          ...previous,
          name: [previous.name, line.name].filter(Boolean).sort()[0] ?? "",
          productId: previous.productId || line.productId,
          quantity: previous.quantity + line.quantity,
          extendedPrice: roundMoney(previous.extendedPrice + line.extendedPrice),
          unitPrice: roundMoney(
            (previous.extendedPrice + line.extendedPrice) /
              (previous.quantity + line.quantity),
          ),
        }
      : { ...line, skuId });
  }
  return [...bySku.values()].sort((a, b) => a.skuId.localeCompare(b.skuId));
}

function sanitizeRefunds(refunds: readonly unknown[]): SellerOrderRefundEvidence[] {
  return refunds.map((value) => {
    const refund = value && typeof value === "object"
      ? value as Record<string, unknown>
      : {};
    return {
      ...(typeof refund.createdAt === "string"
        ? { createdAt: offsetTimestamp(refund.createdAt, "Seller order refund createdAt") }
        : {}),
      ...(typeof refund.type === "string" ? { type: refund.type } : {}),
      ...(typeof refund.amount === "number" ? { amount: refund.amount } : {}),
      ...(typeof refund.origin === "string" ? { origin: refund.origin } : {}),
      ...(typeof refund.shippingAmount === "number"
        ? { shippingAmount: refund.shippingAmount }
        : {}),
      ...(Array.isArray(refund.products)
        ? {
            products: refund.products.map((value) => {
              const product = value && typeof value === "object"
                ? value as Record<string, unknown>
                : {};
              return {
                ...(typeof product.amount === "number" ? { amount: product.amount } : {}),
                ...(typeof product.productId === "string"
                  ? { productId: product.productId }
                  : {}),
                ...(typeof product.skuId === "string" ? { skuId: product.skuId } : {}),
              };
            }).sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
          }
        : {}),
    };
  }).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function offsetTimestamp(value: string, label: string): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must include a UTC offset.`);
  }
  return new Date(value).toISOString();
}

export function fingerprintSellerOrderSummary(summary: SellerOrderSearchSummary): string {
  return createHash("sha256").update(stableJson({
    orderNumber: summary.orderNumber,
    orderDate: offsetTimestamp(summary.orderDate, `Order ${summary.orderNumber} summary orderDate`),
    orderChannel: summary.orderChannel,
    orderStatus: summary.orderStatus,
    shippingType: summary.shippingType,
    productAmount: summary.productAmount,
    shippingAmount: summary.shippingAmount,
    totalAmount: summary.totalAmount,
    buyerPaid: summary.buyerPaid,
    orderFulfillment: summary.orderFulfillment,
  })).digest("hex");
}

export function fingerprintSellerOrder(
  value: Omit<SellerOrderObservation, "fingerprint" | "observedAt">,
): string {
  const revisionIdentity = {
    orderNumber: value.orderNumber,
    orderTime: value.orderTime,
    providerStatus: value.providerStatus,
    lifecycle: value.lifecycle,
    refundStatus: value.refundStatus,
    orderChannel: value.orderChannel,
    orderFulfillment: value.orderFulfillment,
    grossItemProceeds: value.grossItemProceeds,
    lines: aggregateSellerOrderLines(value.lines),
    refunds: value.refunds.map((refund) => ({
      ...refund,
      ...(refund.products
        ? { products: [...refund.products].sort((a, b) => stableJson(a).localeCompare(stableJson(b))) }
        : {}),
    })).sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
  };
  return createHash("sha256").update(stableJson(revisionIdentity)).digest("hex");
}

export function observeSellerOrder(
  sellerKey: string,
  summary: SellerOrderSearchSummary | undefined,
  detail: SellerOrderDetail,
  observedAt = new Date().toISOString(),
): SellerOrderObservation {
  const normalizedSellerKey = sellerKey.trim();
  if (!normalizedSellerKey) throw new Error("Seller key is required.");
  if (!detail.orderNumber.trim()) throw new Error("Order number is required.");
  const orderTime = offsetTimestamp(
    detail.createdAt,
    `Order ${detail.orderNumber} createdAt`,
  );
  if (!Number.isFinite(detail.transaction.productAmount) || detail.transaction.productAmount < 0) {
    throw new Error(`Order ${detail.orderNumber} has invalid gross item proceeds.`);
  }
  const lines = detail.products.map((line) => ({
    name: line.name,
    unitPrice: line.unitPrice,
    extendedPrice: line.extendedPrice,
    quantity: line.quantity,
    productId: line.productId,
    skuId: line.skuId,
  }));
  const refunds = sanitizeRefunds(detail.refunds);
  const base = {
    sellerKey: normalizedSellerKey,
    orderNumber: detail.orderNumber.trim(),
    orderTime,
    ...(summary?.orderDate
      ? { summaryOrderTime: offsetTimestamp(summary.orderDate, `Order ${detail.orderNumber} summary orderDate`) }
      : {}),
    providerStatus: detail.status,
    lifecycle: normalizeSellerOrderLifecycle(detail.status),
    refundStatus: detail.refundStatus,
    orderChannel: detail.orderChannel,
    orderFulfillment: detail.orderFulfillment,
    grossItemProceeds: detail.transaction.productAmount,
    lines,
    refunds,
    source: "tcgplayer_api" as const,
  };
  return {
    ...base,
    observedAt,
    fingerprint: fingerprintSellerOrder(base),
    ...(summary?.orderDate ? { summaryFingerprint: fingerprintSellerOrderSummary(summary) } : {}),
  };
}
