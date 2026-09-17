import {
  REINVESTMENT_TURNAROUND_RULE_VERSION,
  type ReinvestmentTurnaroundReport,
  type ReinvestmentTurnaroundSample,
} from "../types/reinvestmentTurnaround";
import {
  DEFAULT_TURNAROUND_SETTING,
  type TurnaroundEvidenceSummary,
  type TurnaroundSelection,
  type TurnaroundSetting,
} from "../types/turnaroundStrategy";

export const TURNAROUND_EVIDENCE_POLICY = {
  observationDays: 90,
  maximumReportAgeHours: 24,
  maximumOrderCoverageAgeHours: 24,
  minimumCompletedPurchases: 5,
  confidentCompletedPurchases: 20,
  minimumSaleSpanDays: 14,
  supportedOrderSearchRange: "LastThreeMonths",
} as const;

const DAY = 86_400_000;
const HOUR = 3_600_000;

type Evaluation = {
  status: "eligible" | "sparse" | "ineligible";
  reasons: string[];
  evidence: TurnaroundEvidenceSummary | null;
};

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function weightedMean(samples: ReinvestmentTurnaroundSample[]): number | null {
  const total = samples.reduce((sum, sample) => sum + sample.amountCents, 0);
  return total
    ? samples.reduce((sum, sample) => sum + sample.amountCents * (sample.turnaroundDays ?? 0), 0) / total
    : null;
}

function weightedP90(samples: ReinvestmentTurnaroundSample[]): number | null {
  const ordered = [...samples].sort((left, right) =>
    (left.turnaroundDays ?? 0) - (right.turnaroundDays ?? 0) || left.sampleKey.localeCompare(right.sampleKey));
  const total = ordered.reduce((sum, sample) => sum + BigInt(sample.amountCents), 0n);
  if (!total) return null;
  const target = (total * 90n + 99n) / 100n;
  let cumulative = 0n;
  for (const sample of ordered) {
    cumulative += BigInt(sample.amountCents);
    if (cumulative >= target) return sample.turnaroundDays ?? null;
  }
  return ordered.at(-1)?.turnaroundDays ?? null;
}

function settingFor(
  sellerKey: string,
  productLineId: number | null,
  settings: TurnaroundSetting[],
): TurnaroundSetting {
  const exact = settings.find((setting) => setting.sellerKey === sellerKey && setting.productLineId === productLineId);
  const inherited = productLineId === null
    ? undefined
    : settings.find((setting) => setting.sellerKey === sellerKey && setting.productLineId === null);
  const source = exact ?? inherited;
  return {
    sellerKey,
    productLineId,
    mode: source?.mode ?? DEFAULT_TURNAROUND_SETTING.mode,
    manualTurnaroundDays: source?.manualTurnaroundDays ?? DEFAULT_TURNAROUND_SETTING.manualTurnaroundDays,
    updatedAt: source?.updatedAt ?? null,
  };
}

function evaluate(
  report: ReinvestmentTurnaroundReport | null,
  recoveryError: string | null | undefined,
  sellerKey: string,
  productLineId: number | null,
  now: Date,
): Evaluation {
  if (!report) return { status: "ineligible", reasons: ["No saved reinvestment evidence is available."], evidence: null };
  const reasons: string[] = [];
  // Evidence gaps that strategy fills by assumption; they are reported, never blocking.
  const notes: string[] = [];
  const nowMs = now.getTime();
  const asOf = instant(report.asOf);
  if (recoveryError) reasons.push("Current evidence could not be rebuilt; a saved recovery report cannot select observed mode.");
  if (report.ruleVersion !== REINVESTMENT_TURNAROUND_RULE_VERSION) reasons.push("The saved report predates the current reinvestment rule.");
  if (report.sellerKey !== sellerKey) reasons.push("The saved report belongs to a different seller.");
  if (asOf === null || asOf > nowMs || nowMs - asOf > TURNAROUND_EVIDENCE_POLICY.maximumReportAgeHours * HOUR) {
    reasons.push("The report as-of time is missing, future, or older than 24 hours.");
  }
  const orderCoverage = report.orderCoverage;
  if (!orderCoverage) {
    notes.push("No complete Seller Portal order scan is available; proceeds are taken from the orders observed.");
  } else {
    const finishedAt = instant(orderCoverage.finishedAt);
    if (orderCoverage.status !== "complete" || orderCoverage.source !== "tcgplayer_api" ||
        orderCoverage.searchRange !== TURNAROUND_EVIDENCE_POLICY.supportedOrderSearchRange ||
        orderCoverage.expectedTotal === null || orderCoverage.nextOffset < orderCoverage.expectedTotal ||
        orderCoverage.ordersObserved < orderCoverage.expectedTotal || orderCoverage.gaps.length > 0) {
      notes.push("The latest Seller Portal order scan is incomplete; proceeds are taken from the orders observed.");
    }
    if (finishedAt === null || finishedAt > nowMs || nowMs - finishedAt > TURNAROUND_EVIDENCE_POLICY.maximumOrderCoverageAgeHours * HOUR) {
      notes.push("The Seller Portal order scan is older than 24 hours.");
    }
  }
  const currencies = report.currencies.filter((summary) =>
    summary.eligibleProceedsCents !== 0 || summary.completedCents !== 0 || summary.waitingCents !== 0 ||
    summary.unallocatedProceedsCents !== 0 || summary.outsideFundingSuppliedCents !== 0);
  if (currencies.length !== 1 || currencies[0].currency !== "USD") {
    reasons.push("Observed strategy timing requires one USD proceeds pool; currencies are never mixed.");
  }
  const usd = currencies.find((summary) => summary.currency === "USD") ?? null;
  if (usd && (usd.waitingCents > 0 || usd.unallocatedProceedsCents > 0 ||
      usd.reinvestedPercent !== 100 || usd.completionCoveragePercent !== 100)) {
    notes.push("Some proceeds are still waiting or unallocated; only completed cycles are measured.");
  }
  if (report.coverage.unknownProceedsOrderCount > 0) notes.push("Some orders lack proceeds evidence and are left out.");
  if (report.coverage.unknownCostReceiptCount > 0) notes.push("Some received inventory has no cost yet and is left out.");

  const cohortStart = asOf === null ? null : asOf - TURNAROUND_EVIDENCE_POLICY.observationDays * DAY;
  const allScopedSamples = report.samples.filter((sample) => sample.currency === "USD" &&
    (productLineId === null || sample.productLineId === productLineId));
  const completedLifetime = allScopedSamples.filter((sample) => sample.state === "completed");
  const waitingLifetime = allScopedSamples.filter((sample) => sample.state === "waiting");
  if (waitingLifetime.length > 0) notes.push("Some sale proceeds are still waiting for publication and are not yet cycles.");
  const completed = cohortStart === null || asOf === null ? [] : completedLifetime.filter((sample) => {
    const soldAt = instant(sample.soldAt);
    return soldAt !== null && soldAt >= cohortStart && soldAt <= asOf;
  });
  const completedCents = completed.reduce((sum, sample) => sum + sample.amountCents, 0);
  const waitingCents = waitingLifetime.reduce((sum, sample) => sum + sample.amountCents, 0);
  const oldestWaitingDays = waitingLifetime.length
    ? Math.max(...waitingLifetime.map((sample) => sample.waitingAgeDays ?? 0))
    : null;
  const purchases = new Set(completed.map((sample) => sample.purchaseReference)).size;
  const soldTimes = completed.flatMap((sample) => {
    const value = instant(sample.soldAt);
    return value === null ? [] : [value];
  });
  const publishedTimes = completed.flatMap((sample) => {
    const value = instant(sample.publishedAt);
    return value === null ? [] : [value];
  });
  const observationFrom = soldTimes.length ? Math.min(...soldTimes) : null;
  const observationThrough = soldTimes.length ? Math.max(...soldTimes) : null;
  const latestPublication = publishedTimes.length ? Math.max(...publishedTimes) : null;
  if (latestPublication !== null && nowMs - latestPublication > TURNAROUND_EVIDENCE_POLICY.observationDays * DAY) {
    notes.push("The selected cohort has no recently completed replacement publication.");
  }

  const evidence: TurnaroundEvidenceSummary = {
    scope: productLineId === null ? "seller" : "product-line",
    sourceProductLineId: productLineId,
    attribution: productLineId === null ? "seller" : "product-line",
    reportAsOf: report.asOf,
    sourceFingerprint: report.sourceFingerprint,
    observationFrom: observationFrom === null ? null : new Date(observationFrom).toISOString(),
    observationThrough: observationThrough === null ? null : new Date(observationThrough).toISOString(),
    completedPurchaseCount: purchases,
    completedCents,
    waitingCents,
    oldestWaitingDays,
    eligibleProceedsCents: usd?.eligibleProceedsCents ?? 0,
    unallocatedProceedsCents: usd?.unallocatedProceedsCents ?? 0,
    oldestUnallocatedDays: usd?.oldestUnallocatedDays ?? null,
    reinvestedPercent: usd?.reinvestedPercent ?? null,
    completionCoveragePercent: usd?.completionCoveragePercent ?? null,
    typicalDays: weightedMean(completed),
    slowerDays: weightedP90(completed),
    orderCoverageFinishedAt: orderCoverage?.finishedAt ?? null,
    orderObservedFrom: orderCoverage?.observedFrom ?? null,
    orderObservedThrough: orderCoverage?.observedThrough ?? null,
    confidence: purchases >= TURNAROUND_EVIDENCE_POLICY.confidentCompletedPurchases
      ? "high"
      : purchases >= TURNAROUND_EVIDENCE_POLICY.minimumCompletedPurchases
        ? "medium"
        : completed.length > 0 ? "low" : "unavailable",
    limitations: [
      "Costs, proceeds, and funding dates are estimated by the strategy assumptions where evidence is missing; figures are directional.",
      "Typical is a completed dollar-weighted mean of the last 90 days of cycles.",
      "Slower is the completed dollar-weighted p90 scenario, not a confidence bound.",
      ...notes,
    ],
  };
  const noRecentCompleted = completed.length === 0;
  if (productLineId !== null && noRecentCompleted && completedLifetime.length === 0 &&
      waitingLifetime.length === 0 && reasons.length === 0) {
    return { status: "sparse", reasons: ["This product line has no attributed replacement cycles."], evidence };
  }
  if (productLineId !== null && noRecentCompleted && completedLifetime.length > 0) {
    reasons.push("This product line has completed cycles, but none occurred in the current 90-day cohort.");
  }
  const spanDays = observationFrom === null || observationThrough === null
    ? 0
    : (observationThrough - observationFrom) / DAY;
  const sparse = purchases < TURNAROUND_EVIDENCE_POLICY.minimumCompletedPurchases ||
    spanDays < TURNAROUND_EVIDENCE_POLICY.minimumSaleSpanDays;
  if (sparse && reasons.length === 0 && productLineId !== null) {
    return {
      status: "sparse",
      reasons: [`This product line needs ${TURNAROUND_EVIDENCE_POLICY.minimumCompletedPurchases} completed purchases spanning at least ${TURNAROUND_EVIDENCE_POLICY.minimumSaleSpanDays} sale days; it has ${purchases} across ${spanDays.toFixed(1)} days.`],
      evidence,
    };
  }
  if (sparse) reasons.push(`Observed mode needs ${TURNAROUND_EVIDENCE_POLICY.minimumCompletedPurchases} completed purchases spanning at least ${TURNAROUND_EVIDENCE_POLICY.minimumSaleSpanDays} sale days; this cohort has ${purchases} across ${spanDays.toFixed(1)} days.`);
  if (reasons.length > 0) {
    evidence.confidence = "unavailable";
    return { status: "ineligible", reasons, evidence };
  }
  return { status: "eligible", reasons: [], evidence };
}
export function selectTurnaround(
  sellerKey: string,
  productLineId: number | null,
  settings: TurnaroundSetting[],
  report: ReinvestmentTurnaroundReport | null,
  recoveryError: string | null | undefined,
  now = new Date(),
): TurnaroundSelection {
  const setting = settingFor(sellerKey, productLineId, settings);
  let result = evaluate(report, recoveryError, sellerKey, productLineId, now);
  let source: TurnaroundSelection["effectiveSource"] = productLineId === null ? "observed-seller" : "observed-product-line";
  if (result.status === "sparse" && productLineId !== null) {
    const seller = evaluate(report, recoveryError, sellerKey, null, now);
    if (seller.status === "eligible" && seller.evidence) {
      result = {
        ...seller,
        evidence: {
          ...seller.evidence,
          attribution: "seller-substituted-for-sparse-line",
          limitations: [
            ...seller.evidence.limitations,
            `Seller-wide timing is used because product line ${productLineId} has sparse evidence.`,
          ],
        },
      };
      source = "observed-seller";
    } else {
      result = { status: "ineligible", reasons: [...result.reasons, ...seller.reasons], evidence: result.evidence };
    }
  }
  const observed = result.status === "eligible" && result.evidence?.typicalDays !== null;
  return {
    setting,
    effectiveDays: setting.mode === "observed" && observed
      ? result.evidence!.typicalDays!
      : setting.manualTurnaroundDays,
    effectiveSource: setting.mode === "manual" ? "manual" : observed ? source : "manual-fallback",
    fallbackReasons: setting.mode === "manual" ? [] : observed ? [] : result.reasons,
    evidence: result.evidence,
  };
}
