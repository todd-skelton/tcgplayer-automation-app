export type MoneyProvenance = "actual" | "estimated";
export type PurchaseCostAllocationRule = "quantity" | "frozen_market" | "explicit";

export interface WeightedAmountTarget {
  id: string;
  weight: number;
}

export interface AllocatedAmount {
  id: string;
  amountCents: number;
}

export interface PurchaseCostInput {
  requestId: string;
  sellerKey: string;
  purchaseReference: string;
  currency: string;
  totalAmountCents: number;
  provenance: MoneyProvenance;
  source: "intake" | "manual" | "file_import";
  allocationRule: PurchaseCostAllocationRule;
  batchNumbers: number[];
  purchasedAt?: string;
  marketObservedAt?: string;
  correctsEntryId?: string;
  correctionReason?: string;
  explicitAllocations?: Array<{ receiptId: number; amountCents: number }>;
}

export type FundingAdjustmentType =
  | "opening_cash"
  | "external_contribution"
  | "withdrawal"
  | "reserve"
  | "reserve_release"
  | "purchase_funding";

export interface FundingAdjustmentInput {
  requestId: string;
  sellerKey: string;
  adjustmentReference: string;
  currency: string;
  adjustmentType: FundingAdjustmentType;
  amountCents: number;
  provenance: MoneyProvenance;
  effectiveAt: string;
  purchaseReference?: string;
  correctsEntryId?: string;
  correctionReason?: string;
}

export type OrderExpenseType = "fulfillment" | "refund_settlement" | "other";
export type OrderExpenseBasis =
  | "additional_expense"
  | "original_net_refund_adjustment"
  | "already_adjusted_net";

export interface OrderExpenseInput {
  requestId: string;
  sellerKey: string;
  expenseReference: string;
  currency: string;
  expenseType: OrderExpenseType;
  amountCents: number;
  provenance: MoneyProvenance;
  orderNumbers: string[];
  expenseAt: string;
  basis: OrderExpenseBasis;
  correctsEntryId?: string;
  correctionReason?: string;
}

export interface PurchaseCostSummary {
  id: string;
  version: number;
  purchaseReference: string;
  currency: string;
  totalAmountCents: number;
  provenance: MoneyProvenance;
  source: PurchaseCostInput["source"];
  allocationRule: PurchaseCostAllocationRule;
  batchNumbers: number[];
  purchasedAt?: string;
  recordedAt: string;
}

export interface FundingAdjustmentSummary {
  id: string;
  version: number;
  adjustmentReference: string;
  currency: string;
  adjustmentType: FundingAdjustmentType;
  amountCents: number;
  provenance: MoneyProvenance;
  effectiveAt: string;
  purchaseReference?: string;
  recordedAt: string;
}

export interface OrderExpenseSummary {
  id: string;
  version: number;
  expenseReference: string;
  currency: string;
  expenseType: OrderExpenseType;
  amountCents: number;
  provenance: MoneyProvenance;
  orderNumbers: string[];
  expenseAt: string;
  basis: OrderExpenseBasis;
  recordedAt: string;
}

export type EconomicsCoverage = "actual" | "estimated" | "unknown";

export interface OrderEconomicsSummary {
  orderNumber: string;
  currency: string;
  grossItemCents: number;
  grossShippingCents?: number;
  grossOrderCents?: number;
  platformFeeCents?: number;
  providerNetCents?: number;
  refundGrossCents?: number;
  postageCents?: number;
  otherExpenseCents: number;
  acquisitionCostCents?: number;
  reusableCashCents?: number;
  realizedProfitCents?: number;
  proceedsCoverage: EconomicsCoverage;
  expenseCoverage: EconomicsCoverage;
  costCoverage: EconomicsCoverage;
  missing: string[];
}

export interface InventoryEconomicsWorkspace {
  sellerKey: string;
  generatedAt: string;
  purchaseCosts: PurchaseCostSummary[];
  fundingAdjustments: FundingAdjustmentSummary[];
  orderExpenses: OrderExpenseSummary[];
  orders: OrderEconomicsSummary[];
  uncostedBatches: Array<{ batchNumber: number; sourceLabel: string; receiptCount: number }>;
}
