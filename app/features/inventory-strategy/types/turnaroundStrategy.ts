export type TurnaroundMode = "manual" | "observed";

export interface TurnaroundSetting {
  sellerKey: string;
  productLineId: number | null;
  mode: TurnaroundMode;
  manualTurnaroundDays: number;
  updatedAt: string | null;
}

export const DEFAULT_TURNAROUND_SETTING = {
  mode: "observed",
  manualTurnaroundDays: 28,
} as const satisfies Pick<TurnaroundSetting, "mode" | "manualTurnaroundDays">;

export interface TurnaroundEvidenceSummary {
  scope: "seller" | "product-line";
  sourceProductLineId: number | null;
  attribution: "seller" | "product-line" | "seller-substituted-for-sparse-line";
  reportAsOf: string;
  sourceFingerprint: string;
  observationFrom: string | null;
  observationThrough: string | null;
  completedPurchaseCount: number;
  completedCents: number;
  waitingCents: number;
  oldestWaitingDays: number | null;
  eligibleProceedsCents: number;
  unallocatedProceedsCents: number;
  oldestUnallocatedDays: number | null;
  reinvestedPercent: number | null;
  completionCoveragePercent: number | null;
  typicalDays: number | null;
  slowerDays: number | null;
  orderCoverageFinishedAt: string | null;
  orderObservedFrom: string | null;
  orderObservedThrough: string | null;
  confidence: "high" | "medium" | "low" | "unavailable";
  limitations: string[];
}

export interface TurnaroundSelection {
  setting: TurnaroundSetting;
  effectiveDays: number;
  effectiveSource: "manual" | "observed-product-line" | "observed-seller" | "manual-fallback";
  fallbackReasons: string[];
  evidence: TurnaroundEvidenceSummary | null;
}
