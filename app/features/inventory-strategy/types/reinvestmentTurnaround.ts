export const REINVESTMENT_TURNAROUND_RULE_VERSION = "pooled-proceeds/v1";

export type ReinvestmentMoneyProvenance = "actual" | "estimated";
export type ReinvestmentTimingBasis = "known_purchase" | "known_funding" | "sale_to_publication_inference";
export type ReinvestmentAllocationState = "completed" | "waiting";

export interface ReusableSaleProceeds {
  orderNumber: string;
  soldAt: string;
  currency: string;
  amountCents: number;
  provenance: ReinvestmentMoneyProvenance;
  sourceIdentity: string;
  sourceIdentities?: string[];
}

export interface ReinvestmentPublicationTranche {
  receiptId: number;
  publicationItemId?: string;
  amountCents: number;
  quantity: number;
  publishedAt?: string;
  publicationState: "confirmed" | "waiting" | "unsupported";
  publicationIdentity?: string;
}

export interface ReplacementPurchase {
  purchaseReference: string;
  currency: string;
  totalAmountCents: number;
  costProvenance: ReinvestmentMoneyProvenance;
  costSourceIdentity: string;
  purchasedAt?: string;
  funding: Array<{
    adjustmentReference: string;
    amountCents: number;
    effectiveAt: string;
    provenance: ReinvestmentMoneyProvenance;
    sourceIdentity: string;
  }>;
  tranches: ReinvestmentPublicationTranche[];
}

export interface ReinvestmentFundingAdjustment {
  adjustmentReference: string;
  currency: string;
  adjustmentType: "opening_cash" | "external_contribution" | "withdrawal" | "reserve" | "reserve_release";
  amountCents: number;
  effectiveAt: string;
  provenance: ReinvestmentMoneyProvenance;
  sourceIdentity: string;
}

export interface ReinvestmentTurnaroundInput {
  sellerKey: string;
  asOf: string;
  sales: ReusableSaleProceeds[];
  purchases: ReplacementPurchase[];
  fundingAdjustments: ReinvestmentFundingAdjustment[];
  unknownProceedsOrderCount: number;
  unknownProceedsSoldAt?: string[];
  unknownCostReceiptCount: number;
  unknownCostOccurredAt?: Array<string|null>;
  sourceEvidenceIdentities: string[];
}

export interface ReinvestmentTurnaroundSample {
  sampleKey: string;
  currency: string;
  orderNumber: string;
  purchaseReference: string;
  receiptId: number;
  amountCents: number;
  soldAt: string;
  fundingAt: string;
  publishedAt?: string;
  state: ReinvestmentAllocationState;
  timingBasis: ReinvestmentTimingBasis;
  proceedsProvenance: ReinvestmentMoneyProvenance;
  costProvenance: ReinvestmentMoneyProvenance;
  fundingProvenance: ReinvestmentMoneyProvenance | "inferred";
  fundingAdjustmentReference?: string;
  turnaroundDays?: number;
  waitingAgeDays?: number;
  explanation: string;
  sourceIdentities: string[];
}

export interface ReinvestmentCurrencySummary {
  currency: string;
  eligibleProceedsCents: number;
  negativeProceedsCents: number;
  completedCents: number;
  waitingCents: number;
  unallocatedProceedsCents: number;
  reservedOrWithdrawnCents: number;
  unsupportedFundingAdjustmentCents: number;
  outsideFundingUsedCents: number;
  outsideFundingSuppliedCents: number;
  outsideDeficitSettlementCents: number;
  outsideAvailableCents: number;
  outsideReservedOrWithdrawnCents: number;
  outstandingNegativeDeficitCents: number;
  unresolvedPurchaseCostCents: number;
  reinvestedPercent: number | null;
  completionCoveragePercent: number | null;
  completedDollarWeightedMeanDays: number | null;
  completedWeightedMedianDays: number | null;
  completedWeightedP90Days: number | null;
  waitingDollarWeightedAgeDays: number | null;
  oldestWaitingDays: number | null;
  unallocatedDollarWeightedAgeDays: number | null;
  oldestUnallocatedDays: number | null;
}

export interface ReinvestmentTurnaroundReport {
  sellerKey: string;
  asOf: string;
  ruleVersion: typeof REINVESTMENT_TURNAROUND_RULE_VERSION;
  sourceFingerprint: string;
  currentCorrectedView: true;
  datePrecision: "timestamp_sales_date_funding";
  currencies: ReinvestmentCurrencySummary[];
  samples: ReinvestmentTurnaroundSample[];
  excluded: Array<{ reason: string; count: number; amountCents?: number; currency?: string }>;
  coverage: {
    observedOrderCount: number;
    eligibleOrderCount: number;
    unknownProceedsOrderCount: number;
    purchaseCount: number;
    costedReceiptCount: number;
    unknownCostReceiptCount: number;
  };
  convention: string[];
}
