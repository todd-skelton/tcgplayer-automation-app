import type { EconomicsCoverage, OrderEconomicsSummary } from "../types/inventoryEconomics";

export interface OrderEconomicsEvidence {
  orderNumber: string;
  currency: string;
  grossItemCents: number;
  grossShippingCents?: number;
  grossOrderCents?: number;
  platformFeeCents?: number;
  providerNetCents?: number;
  directFeeCents?: number;
  refundGrossCents?: number;
  refundSettlement?: {
    amountCents: number;
    provenance: "actual" | "estimated";
    basis: "original_net_refund_adjustment" | "already_adjusted_net";
  };
  postageCents?: number;
  postageCoverage: EconomicsCoverage;
  otherExpenses: Array<{ amountCents: number; provenance: "actual" | "estimated" }>;
  acquisitionCostCents?: number;
  acquisitionCostCoverage: EconomicsCoverage;
}

export function calculateOrderEconomics(
  evidence: OrderEconomicsEvidence,
): OrderEconomicsSummary {
  const missing: string[] = [];
  const transactionKnown =
    evidence.grossShippingCents !== undefined &&
    evidence.grossOrderCents !== undefined &&
    evidence.platformFeeCents !== undefined &&
    evidence.providerNetCents !== undefined &&
    evidence.grossItemCents + evidence.grossShippingCents === evidence.grossOrderCents &&
    evidence.grossOrderCents - evidence.platformFeeCents === evidence.providerNetCents;
  if (!transactionKnown) missing.push("verified provider transaction totals");
  if ((evidence.directFeeCents ?? 0) !== 0) missing.push("nonzero direct-fee semantics");

  const refunded = (evidence.refundGrossCents ?? 0) > 0;
  if (refunded && !evidence.refundSettlement) {
    missing.push("verified refund settlement or fee credit");
  }
  if (evidence.postageCoverage === "unknown") missing.push("postage expense");
  if (evidence.acquisitionCostCoverage === "unknown") missing.push("acquisition cost");

  const hasEstimatedExpense =
    evidence.postageCoverage === "estimated" ||
    evidence.otherExpenses.some((expense) => expense.provenance === "estimated") ||
    evidence.refundSettlement?.provenance === "estimated";
  const expenseCoverage: EconomicsCoverage =
    evidence.postageCoverage === "unknown" || (refunded && !evidence.refundSettlement)
      ? "unknown"
      : hasEstimatedExpense ? "estimated" : "actual";
  const proceedsCoverage: EconomicsCoverage =
    !transactionKnown || ((evidence.directFeeCents ?? 0) !== 0) || (refunded && !evidence.refundSettlement)
      ? "unknown"
      : evidence.refundSettlement?.provenance === "estimated" ? "estimated" : "actual";

  let reusableCashCents: number | undefined;
  if (proceedsCoverage !== "unknown" && expenseCoverage !== "unknown") {
    const baseNet = evidence.refundSettlement?.basis === "already_adjusted_net"
      ? evidence.refundSettlement.amountCents
      : evidence.providerNetCents!;
    const refundAdjustment = evidence.refundSettlement?.basis === "original_net_refund_adjustment"
      ? evidence.refundSettlement.amountCents
      : 0;
    reusableCashCents = baseNet - refundAdjustment - (evidence.postageCents ?? 0) -
      evidence.otherExpenses.reduce((sum, expense) => sum + expense.amountCents, 0);
  }

  const realizedProfitCents =
    reusableCashCents !== undefined && evidence.acquisitionCostCoverage !== "unknown"
      ? reusableCashCents - (evidence.acquisitionCostCents ?? 0)
      : undefined;

  return {
    orderNumber: evidence.orderNumber,
    currency: evidence.currency,
    grossItemCents: evidence.grossItemCents,
    ...(evidence.grossShippingCents !== undefined ? { grossShippingCents: evidence.grossShippingCents } : {}),
    ...(evidence.grossOrderCents !== undefined ? { grossOrderCents: evidence.grossOrderCents } : {}),
    ...(evidence.platformFeeCents !== undefined ? { platformFeeCents: evidence.platformFeeCents } : {}),
    ...(evidence.providerNetCents !== undefined ? { providerNetCents: evidence.providerNetCents } : {}),
    ...(evidence.refundGrossCents !== undefined ? { refundGrossCents: evidence.refundGrossCents } : {}),
    ...(evidence.postageCents !== undefined ? { postageCents: evidence.postageCents } : {}),
    otherExpenseCents: evidence.otherExpenses.reduce((sum, expense) => sum + expense.amountCents, 0),
    ...(evidence.acquisitionCostCents !== undefined ? { acquisitionCostCents: evidence.acquisitionCostCents } : {}),
    ...(reusableCashCents !== undefined ? { reusableCashCents } : {}),
    ...(realizedProfitCents !== undefined ? { realizedProfitCents } : {}),
    proceedsCoverage,
    expenseCoverage,
    costCoverage: evidence.acquisitionCostCoverage,
    missing,
  };
}
