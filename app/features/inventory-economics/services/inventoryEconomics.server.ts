import { createHash } from "node:crypto";
import { inventoryEconomicsRepository } from "~/core/db";
import { allocateAmountCents } from "../domain/money";
import { calculateOrderEconomics } from "../domain/orderEconomics";
import { allocatePurchasedPostage } from "../domain/postage";
import type { InventoryEconomicsWorkspace, OrderExpenseSummary } from "../types/inventoryEconomics";

type Evidence = Awaited<ReturnType<typeof inventoryEconomicsRepository.findWorkspaceEvidence>>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") { const object=value as Record<string,unknown>;
    return `{${Object.keys(object).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`; }
  return JSON.stringify(value);
}
function financialFingerprint(order: Evidence["orders"][number]): string {
  return createHash("sha256").update(stableJson({transaction:order.transactionEvidence,refunds:order.refunds})).digest("hex");
}
function refundEvidence(refundStatus: string | null, refunds: unknown) {
  const noRefund = refundStatus?.trim().toLowerCase() === "no refund";
  if (!Array.isArray(refunds)) return { status:"unknown" as const };
  if (noRefund && refunds.length === 0) return { status:"none" as const };
  if (!refunds.length) return { status:"unknown" as const };
  const amounts = refunds.map((refund) =>
    refund && typeof refund === "object" ? (refund as { amount?: unknown }).amount : undefined);
  if (amounts.some((amount) => typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 ||
      !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7)) {
    return { status:"unknown" as const };
  }
  return { status:"known" as const,cents:(amounts as number[]).reduce((sum,amount)=>sum+Math.round(amount*100),0) };
}

function allocateSharedExpenses(expenses: readonly OrderExpenseSummary[]) {
  const byOrder = new Map<string, Array<{ amountCents: number; provenance: "actual" | "estimated"; type: string; basis: string; financialSourceFingerprint?: string }>>();
  for (const expense of expenses) {
    const orders = [...new Set(expense.orderNumbers)].sort();
    const allocations = expense.expenseType === "refund_settlement"
      ? [{ id: orders[0] ?? "", amountCents: expense.amountCents }]
      : allocateAmountCents(expense.amountCents, orders.map((id) => ({ id, weight: 1 })));
    for (const allocation of allocations) {
      const key = `${expense.currency}\u0000${allocation.id}`;
      const values = byOrder.get(key) ?? [];
      values.push({ amountCents: allocation.amountCents, provenance: expense.provenance,
        type: expense.expenseType, basis: expense.basis,
        ...(expense.financialSourceFingerprint ? { financialSourceFingerprint:expense.financialSourceFingerprint } : {}) });
      byOrder.set(key, values);
    }
  }
  return byOrder;
}

function allocateReceiptCosts(evidence: Evidence) {
  const byReceipt = new Map<number, typeof evidence.allocations>();
  const settledByOrder = new Map<string,number>();
  if (!evidence.allocationsComplete) return { byOrder:new Map<string, { cents: number; provenance: "actual" | "estimated"; quantity: number; currency: string }>(),settledByOrder };
  for (const allocation of evidence.allocations) {
    const rows = byReceipt.get(allocation.receiptId) ?? [];
    rows.push(allocation); byReceipt.set(allocation.receiptId, rows);
  }
  const byOrder = new Map<string, { cents: number; provenance: "actual" | "estimated"; quantity: number; currency: string }>();
  for (const rows of byReceipt.values()) {
    const sample = rows[0];
    const soldByOrder = new Map<string, number>();
    for (const row of rows) {
      if (row.dispositionId || row.quantityCorrectionId || row.replayStatus !== null ||
          (row.fifoState !== "allocated" && row.fifoState !== "partial")) continue;
      soldByOrder.set(row.orderId, (soldByOrder.get(row.orderId) ?? 0) + row.quantity);
      settledByOrder.set(row.orderId,(settledByOrder.get(row.orderId)??0)+row.quantity);
    }
    if (sample.allocatedCostCents === null || sample.costProvenance === null || sample.costCurrency === null) continue;
    const sold = [...soldByOrder.entries()].map(([id, weight]) => ({ id, weight }));
    const soldQuantity = sold.reduce((sum, value) => sum + value.weight, 0);
    const targets = [...sold, ...(sample.originalQuantity > soldQuantity
      ? [{ id: "__remaining_inventory__", weight: sample.originalQuantity - soldQuantity }] : [])];
    for (const allocation of allocateAmountCents(sample.allocatedCostCents, targets)) {
      if (allocation.id === "__remaining_inventory__") continue;
      const prior = byOrder.get(allocation.id);
      byOrder.set(allocation.id, {
        cents: (prior?.cents ?? 0) + allocation.amountCents,
        provenance: prior?.provenance === "estimated" || sample.costProvenance === "estimated" ? "estimated" : "actual",
        quantity: (prior?.quantity ?? 0) + (soldByOrder.get(allocation.id) ?? 0),
        currency: prior && prior.currency !== sample.costCurrency ? "" : sample.costCurrency,
      });
    }
  }
  return { byOrder,settledByOrder };
}

export async function loadInventoryEconomicsWorkspace(sellerKey: string): Promise<InventoryEconomicsWorkspace> {
  const seller = sellerKey.trim();
  const [purchaseCosts, fundingAdjustments, orderExpenses, evidence] = await Promise.all([
    inventoryEconomicsRepository.listPurchaseCosts(seller),
    inventoryEconomicsRepository.listFundingAdjustments(seller),
    inventoryEconomicsRepository.listOrderExpenses(seller),
    inventoryEconomicsRepository.findWorkspaceEvidence(seller),
  ]);
  const expensesByOrder = allocateSharedExpenses(evidence.relevantOrderExpenses);
  const costEvidence = allocateReceiptCosts(evidence);
  const postageByOrder = evidence.postageComplete
    ? allocatePurchasedPostage(seller, "USD", evidence.postage) : new Map<string,number>();
  return {
    sellerKey: seller,
    generatedAt: new Date().toISOString(),
    purchaseCosts,
    fundingAdjustments,
    orderExpenses,
    uncostedBatches: evidence.uncostedBatches,
    orders: evidence.orders.map((order) => {
      const expenses = expensesByOrder.get(`${order.currency}\u0000${order.orderNumber}`) ?? [];
      const settlement = expenses.find((expense) => expense.type === "refund_settlement" &&
        expense.financialSourceFingerprint === financialFingerprint(order));
      const otherExpenses = expenses.filter((expense) => expense.type !== "refund_settlement")
        .map(({ amountCents, provenance }) => ({ amountCents, provenance }));
      const rawCost = costEvidence.byOrder.get(order.id);
      const settledQuantity = costEvidence.settledByOrder.get(order.id) ?? 0;
      const cost = rawCost && rawCost.quantity === order.orderedQuantity && settledQuantity === order.orderedQuantity &&
        rawCost.currency === order.currency ? rawCost : undefined;
      const postageCents = postageByOrder.get(order.orderNumber);
      const hasExplicitFulfillment = expenses.some((expense) => expense.type === "fulfillment");
      const refund = refundEvidence(order.refundStatus,order.refunds);
      return calculateOrderEconomics({
        orderNumber: order.orderNumber,
        currency: order.currency,
        lifecycle:order.lifecycle,orderedQuantity:order.orderedQuantity,settledQuantity,
        costKnownQuantity:rawCost?.quantity ?? 0,
        grossItemCents: order.grossItemCents,
        ...(order.grossShippingCents !== null ? { grossShippingCents: order.grossShippingCents } : {}),
        ...(order.grossOrderCents !== null ? { grossOrderCents: order.grossOrderCents } : {}),
        ...(order.platformFeeCents !== null ? { platformFeeCents: order.platformFeeCents } : {}),
        ...(order.providerNetCents !== null ? { providerNetCents: order.providerNetCents } : {}),
        ...(order.directFeeCents !== null ? { directFeeCents: order.directFeeCents } : {}),
        refundEvidence:refund.status,...(refund.status === "known" ? { refundGrossCents:refund.cents } : {}),
        ...(settlement ? { refundSettlement: { amountCents: settlement.amountCents,
          provenance: settlement.provenance, basis: settlement.basis as "original_net_refund_adjustment" | "already_adjusted_net" } } : {}),
        ...(postageCents !== undefined ? { postageCents } : {}),
        postageCoverage: postageCents !== undefined ? "actual"
          : hasExplicitFulfillment ? (expenses.some((expense) => expense.provenance === "estimated") ? "estimated" : "actual") : "unknown",
        expenseEvidenceComplete:evidence.relevantExpensesComplete,
        otherExpenses,
        ...(cost ? { acquisitionCostCents: cost.cents } : {}),
        acquisitionCostCoverage: cost ? cost.provenance : "unknown",
      });
    }),
  };
}
