import { inventoryEconomicsRepository } from "~/core/db";
import { allocateAmountCents } from "../domain/money";
import { calculateOrderEconomics } from "../domain/orderEconomics";
import { allocatePurchasedPostage } from "../domain/postage";
import type { InventoryEconomicsWorkspace, OrderExpenseSummary } from "../types/inventoryEconomics";

type Evidence = Awaited<ReturnType<typeof inventoryEconomicsRepository.findWorkspaceEvidence>>;

function refundCents(refunds: Array<{ amount?: number }>): number | undefined {
  const amounts = refunds.filter((refund) => typeof refund.amount === "number" && Number.isFinite(refund.amount))
    .map((refund) => Math.round(refund.amount! * 100));
  return amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : undefined;
}

function allocateSharedExpenses(expenses: readonly OrderExpenseSummary[]) {
  const byOrder = new Map<string, Array<{ amountCents: number; provenance: "actual" | "estimated"; type: string; basis: string }>>();
  for (const expense of expenses) {
    const orders = [...new Set(expense.orderNumbers)].sort();
    const allocations = expense.expenseType === "refund_settlement"
      ? [{ id: orders[0] ?? "", amountCents: expense.amountCents }]
      : allocateAmountCents(expense.amountCents, orders.map((id) => ({ id, weight: 1 })));
    for (const allocation of allocations) {
      const key = `${expense.currency}\u0000${allocation.id}`;
      const values = byOrder.get(key) ?? [];
      values.push({ amountCents: allocation.amountCents, provenance: expense.provenance,
        type: expense.expenseType, basis: expense.basis });
      byOrder.set(key, values);
    }
  }
  return byOrder;
}

function allocateReceiptCosts(evidence: Evidence) {
  const byReceipt = new Map<number, typeof evidence.allocations>();
  if (!evidence.allocationsComplete) return new Map<string, { cents: number; provenance: "actual" | "estimated"; quantity: number; currency: string }>();
  for (const allocation of evidence.allocations) {
    const rows = byReceipt.get(allocation.receiptId) ?? [];
    rows.push(allocation); byReceipt.set(allocation.receiptId, rows);
  }
  const byOrder = new Map<string, { cents: number; provenance: "actual" | "estimated"; quantity: number; currency: string }>();
  for (const rows of byReceipt.values()) {
    const sample = rows[0];
    if (sample.allocatedCostCents === null || sample.costProvenance === null || sample.costCurrency === null) continue;
    const soldByOrder = new Map<string, number>();
    for (const row of rows) {
      if (row.dispositionId || row.quantityCorrectionId) continue;
      soldByOrder.set(row.orderId, (soldByOrder.get(row.orderId) ?? 0) + row.quantity);
    }
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
  return byOrder;
}

export async function loadInventoryEconomicsWorkspace(sellerKey: string): Promise<InventoryEconomicsWorkspace> {
  const seller = sellerKey.trim();
  const [purchaseCosts, fundingAdjustments, orderExpenses, evidence] = await Promise.all([
    inventoryEconomicsRepository.listPurchaseCosts(seller),
    inventoryEconomicsRepository.listFundingAdjustments(seller),
    inventoryEconomicsRepository.listOrderExpenses(seller),
    inventoryEconomicsRepository.findWorkspaceEvidence(seller),
  ]);
  const expensesByOrder = allocateSharedExpenses(orderExpenses);
  const costByOrder = allocateReceiptCosts(evidence);
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
      const settlement = expenses.find((expense) => expense.type === "refund_settlement");
      const otherExpenses = expenses.filter((expense) => expense.type !== "refund_settlement")
        .map(({ amountCents, provenance }) => ({ amountCents, provenance }));
      const rawCost = costByOrder.get(order.id);
      const cost = rawCost && rawCost.quantity === order.orderedQuantity && rawCost.currency === order.currency ? rawCost : undefined;
      const postageCents = postageByOrder.get(order.orderNumber);
      const hasExplicitFulfillment = expenses.some((expense) => expense.type === "fulfillment");
      return calculateOrderEconomics({
        orderNumber: order.orderNumber,
        currency: order.currency,
        grossItemCents: order.grossItemCents,
        ...(order.grossShippingCents !== null ? { grossShippingCents: order.grossShippingCents } : {}),
        ...(order.grossOrderCents !== null ? { grossOrderCents: order.grossOrderCents } : {}),
        ...(order.platformFeeCents !== null ? { platformFeeCents: order.platformFeeCents } : {}),
        ...(order.providerNetCents !== null ? { providerNetCents: order.providerNetCents } : {}),
        ...(order.directFeeCents !== null ? { directFeeCents: order.directFeeCents } : {}),
        ...(refundCents(order.refunds) !== undefined ? { refundGrossCents: refundCents(order.refunds) } : {}),
        ...(settlement ? { refundSettlement: { amountCents: settlement.amountCents,
          provenance: settlement.provenance, basis: settlement.basis as "original_net_refund_adjustment" | "already_adjusted_net" } } : {}),
        ...(postageCents !== undefined ? { postageCents } : {}),
        postageCoverage: postageCents !== undefined ? "actual"
          : hasExplicitFulfillment ? (expenses.some((expense) => expense.provenance === "estimated") ? "estimated" : "actual") : "unknown",
        otherExpenses,
        ...(cost ? { acquisitionCostCents: cost.cents } : {}),
        acquisitionCostCoverage: cost ? cost.provenance : "unknown",
      });
    }),
  };
}
