import { createHash } from "node:crypto";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";

const DAY_MS = 86_400_000;

export const FORECAST_EVALUATION_POLICY = {
  version: "next-seller-sku-sale-v1",
  probabilityModel: "constant-hazard-median-v1",
  horizonDays: 21,
  lookbackDays: 365,
  validationDays: 84,
  reservedDays: 28,
  maximumExposureGapDays: 7,
  minimumCoverage: 0.6,
  minimumTrainingCount: 40,
  minimumValidationCount: 20,
  minimumPairedValidationCount: 20,
  minimumBrierImprovement: 0.01,
  maximumCalibrationRegression: 0.02,
  maximumEvidenceAgeDays: 7,
  candidateMedianDaysMultipliers: [0.75, 0.9, 1.1, 1.25],
} as const;

export type ForecastFamily = "curve" | "buyer-choice" | "condition-rate";
export type ForecastSplit = "training" | "validation" | "reserved";

export interface PublicationForecastSpell {
  publicationItemId: string;
  sellerKey: string;
  sku: number;
  productLine: string;
  productLineId?: number | null;
  publishedAt: string | null;
  nextPublishedAt: string | null;
  desiredPrice: number;
  quantity: number;
  forecastEvidence: unknown;
  forecastEvidenceProvenance: "recorded" | "estimated" | "unknown";
}

export interface SellerSkuOrderRevision {
  orderId: string;
  orderNumber: string;
  revision: number;
  observedAt: string;
  orderTime: string;
  orderTimeEvidence: "detail_canonical" | "summary_only" | "unknown";
  lifecycle: string;
  source: "tcgplayer_api" | "file_import";
  sku: number;
  quantity: number;
}

export interface InventoryExposureObservation {
  observationId: string;
  sku: number;
  observedAt: string;
  quantity: number;
}

export interface FifoSettlementEvidence {
  sku: number;
  state: "settled" | "pending" | "held" | "unavailable";
  revisionIds: string[];
  latestRecordedAt: string | null;
}

export interface ForecastEvaluationEvidence {
  sellerKey: string;
  evaluatedAt: string;
  orderHistory: {
    runId: string | null;
    status: "complete" | "incomplete" | "running" | "not_started";
    coveredFrom: string | null;
    cutoffAt: string | null;
    gaps: string[];
  };
  spells: PublicationForecastSpell[];
  orderRevisions: SellerSkuOrderRevision[];
  exposure: InventoryExposureObservation[];
  fifo: FifoSettlementEvidence[];
  /** Aggregate unsupported publications omitted from the bounded detail read. */
  sourceExclusions?: Partial<Record<ForecastExclusionReason, { spells: number; quantity: number }>>;
}

export interface ForecastValue {
  family: ForecastFamily;
  version: string;
  medianDays: number;
  probabilityModel: typeof FORECAST_EVALUATION_POLICY.probabilityModel;
  probability: number;
}

export type ForecastExclusionReason =
  | "missing_publication_date"
  | "missing_forecast"
  | "forecast_not_recorded"
  | "forecast_time_invalid"
  | "forecast_price_mismatch"
  | "unsupported_forecast_distribution"
  | "order_history_incomplete"
  | "order_history_gap"
  | "outside_order_history"
  | "fifo_pending"
  | "fifo_held"
  | "fifo_unavailable"
  | "repriced_before_horizon"
  | "immature_window"
  | "stock_removed"
  | "exposure_unavailable"
  | "correlated_sku_cross_split"
  | "source_limit";

export interface EvaluatedForecastSpell {
  publicationItemId: string;
  sku: number;
  productLine: string;
  quantity: number;
  publishedAt: string;
  horizonEndsAt: string;
  split: ForecastSplit;
  sold: boolean;
  soldAt: string | null;
  orderEvidence: null | {
    orderId: string;
    orderNumber: string;
    revision: number;
    observedAt: string;
    quantity: number;
  };
  fifoRevisionIds: string[];
  fifoLatestRecordedAt: string | null;
  exposureObservationIds: string[];
  forecasts: ForecastValue[];
  forecastHash: string;
}

export interface ForecastScore {
  count: number;
  soldShare: number;
  expectedShare: number;
  brier: number;
  calibrationError: number;
}

export interface ForecastModelEvaluation {
  family: ForecastFamily;
  version: string;
  training: ForecastScore;
  validation: ForecastScore;
  reservedCount: number;
}

export interface PairedForecastComparison {
  left: string;
  right: string;
  validationCount: number;
  leftBrier: number | null;
  rightBrier: number | null;
}

export interface ForecastCorrectionEvaluation {
  version: string;
  family: "curve";
  sourceModelVersion: string;
  medianDaysMultiplier: number;
  training: ForecastScore;
  validation: ForecastScore;
  validationBrierImprovement: number;
  validationCalibrationRegression: number;
  eligible: boolean;
  reasons: string[];
  validationCoverage: number;
  productLines: Array<{
    productLine: string;
    productLineId: number | null;
    medianDaysMultiplier: number | null;
    training: ForecastScore;
    validation: ForecastScore;
    validationCoverage: number;
    eligible: boolean;
    reasons: string[];
  }>;
}

export interface ForecastEvaluationReport {
  /** Persisted identity added by the server; absent only during pure evaluation. */
  evaluationId?: string;
  /** Material source identity checked again before every pricing use. */
  materialEvidenceVersion?: string;
  policy: typeof FORECAST_EVALUATION_POLICY;
  sellerKey: string;
  evaluatedAt: string;
  fitCutoff: string;
  validationCutoff: string;
  evidenceFingerprint: string;
  status: "eligible" | "abstained";
  statusReasons: string[];
  provenance: ForecastEvaluationEvidence["orderHistory"];
  coverage: {
    totalSpells: number;
    includedSpells: number;
    includedQuantity: number;
    coverage: number;
    excludedSpells: number;
    excludedQuantity: number;
    exclusions: Partial<Record<ForecastExclusionReason, { spells: number; quantity: number }>>;
  };
  observations: EvaluatedForecastSpell[];
  models: ForecastModelEvaluation[];
  pairedComparisons: PairedForecastComparison[];
  correction: ForecastCorrectionEvaluation | null;
}

function milliseconds(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** A median is converted only for forecast families defined as constant hazards. */
export function constantHazardSaleProbability(
  medianDays: number,
  horizonDays: number,
): number {
  return 1 - Math.pow(0.5, horizonDays / medianDays);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readForecasts(
  spell: PublicationForecastSpell,
): { forecasts: ForecastValue[]; reason?: ForecastExclusionReason } {
  if (spell.forecastEvidenceProvenance !== "recorded") {
    return { forecasts: [], reason: "forecast_not_recorded" };
  }
  if (!spell.forecastEvidence || typeof spell.forecastEvidence !== "object") {
    return { forecasts: [], reason: "missing_forecast" };
  }
  const evidence = spell.forecastEvidence as Record<string, any>;
  if (
    evidence.source !== "publication_candidate" &&
    evidence.source !== "historical_pricing_result_exact_match"
  ) {
    return { forecasts: [], reason: "unsupported_forecast_distribution" };
  }
  const pricedAt = milliseconds(typeof evidence.pricedAt === "string" ? evidence.pricedAt : null);
  const publishedAt = milliseconds(spell.publishedAt);
  if (pricedAt === null || publishedAt === null || pricedAt > publishedAt) {
    return { forecasts: [], reason: "forecast_time_invalid" };
  }
  const decision = evidence.decision as Record<string, unknown> | undefined;
  if (
    decision &&
    positive(decision.selectedPrice) &&
    Math.abs(decision.selectedPrice - spell.desiredPrice) >= 0.005
  ) {
    return { forecasts: [], reason: "forecast_price_mismatch" };
  }
  const forecasts: ForecastValue[] = [];
  const add = (family: ForecastFamily, version: unknown, medianDays: unknown) => {
    if (typeof version !== "string" || !version || !positive(medianDays)) return;
    forecasts.push({
      family,
      version,
      medianDays,
      probabilityModel: FORECAST_EVALUATION_POLICY.probabilityModel,
      probability: constantHazardSaleProbability(
        medianDays,
        FORECAST_EVALUATION_POLICY.horizonDays,
      ),
    });
  };
  // Curve sell time is derived from buyer arrivals and store win share, so it
  // has the same constant-hazard semantics. A target-horizon decision merely
  // repeats the requested horizon and is not a forecast.
  if (decision?.basis === "modeled" && decision.method !== "target-horizon") {
    if (typeof evidence.pricingModelVersion === "string" && evidence.pricingModelVersion) {
      const policy = evidence.policy as Record<string, any> | undefined;
      const appliedCorrection =
        (typeof decision.forecastCorrectionVersion === "string" && decision.forecastCorrectionVersion) ||
        (typeof policy?.forecastCorrection?.version === "string" && policy.forecastCorrection.version) ||
        null;
      add(
        "curve",
        `curve:${evidence.pricingModelVersion}${appliedCorrection ? `+correction:${appliedCorrection}` : ""}`,
        decision.estimatedMedianSellDays,
      );
    }
  }
  const buyerChoice = evidence.buyerChoiceForecast as Record<string, unknown> | undefined;
  if (typeof buyerChoice?.calibration === "string" && buyerChoice.calibration) {
    add("buyer-choice", `buyer-choice:${buyerChoice.calibration}`, buyerChoice.medianSellDays);
  }
  const conditionRate = evidence.conditionRateForecast as Record<string, unknown> | undefined;
  if (typeof conditionRate?.method === "string" && conditionRate.method) {
    add("condition-rate", `condition-rate:${conditionRate.method}`, conditionRate.medianSellDays);
  }
  return forecasts.length > 0
    ? { forecasts }
    : { forecasts: [], reason: "missing_forecast" };
}

function score(
  observations: readonly EvaluatedForecastSpell[],
  family: ForecastFamily,
  version: string,
  multiplier = 1,
): ForecastScore {
  const values = observations.flatMap((observation) => {
    const forecast = observation.forecasts.find(
      (candidate) => candidate.family === family && candidate.version === version,
    );
    if (!forecast) return [];
    const probability = constantHazardSaleProbability(
      forecast.medianDays * multiplier,
      FORECAST_EVALUATION_POLICY.horizonDays,
    );
    return [{ sold: observation.sold ? 1 : 0, probability }];
  });
  if (values.length === 0) {
    return { count: 0, soldShare: 0, expectedShare: 0, brier: 0, calibrationError: 0 };
  }
  const mean = (select: (value: (typeof values)[number]) => number) =>
    values.reduce((sum, value) => sum + select(value), 0) / values.length;
  const soldShare = mean((value) => value.sold);
  const expectedShare = mean((value) => value.probability);
  return {
    count: values.length,
    soldShare,
    expectedShare,
    brier: mean((value) => (value.probability - value.sold) ** 2),
    calibrationError: Math.abs(expectedShare - soldShare),
  };
}

function evidenceKnownAt(order: SellerSkuOrderRevision): number {
  return Math.max(milliseconds(order.orderTime) ?? Infinity, milliseconds(order.observedAt) ?? Infinity);
}

/**
 * Builds the frozen, leakage-safe evaluation. The candidate grid and every
 * activation threshold are constants above and are never learned from the
 * validation block.
 */
export function evaluateForecastEvidence(
  evidence: ForecastEvaluationEvidence,
): ForecastEvaluationReport {
  const policy = FORECAST_EVALUATION_POLICY;
  const evaluatedAt = milliseconds(evidence.evaluatedAt) ?? 0;
  const validationCutoff = evaluatedAt - policy.reservedDays * DAY_MS;
  const fitCutoff = validationCutoff - policy.validationDays * DAY_MS;
  const lookbackFrom = evaluatedAt - policy.lookbackDays * DAY_MS;
  const orderCutoff = milliseconds(evidence.orderHistory.cutoffAt);
  const orderFrom = milliseconds(evidence.orderHistory.coveredFrom);
  const completeHistory =
    evidence.orderHistory.status === "complete" &&
    evidence.orderHistory.gaps.length === 0 &&
    orderCutoff !== null;
  const fifoBySku = new Map(evidence.fifo.map((value) => [value.sku, value]));
  const exposureBySku = new Map<number, InventoryExposureObservation[]>();
  for (const observation of evidence.exposure) {
    if ((milliseconds(observation.observedAt) ?? Infinity) > evaluatedAt) continue;
    exposureBySku.set(observation.sku, [...(exposureBySku.get(observation.sku) ?? []), observation]);
  }
  for (const observations of exposureBySku.values()) {
    observations.sort((left, right) => (milliseconds(left.observedAt) ?? 0) - (milliseconds(right.observedAt) ?? 0));
  }
  const ordersBySku = new Map<number, SellerSkuOrderRevision[]>();
  for (const order of evidence.orderRevisions) {
    if (evidenceKnownAt(order) > evaluatedAt || order.orderTimeEvidence !== "detail_canonical") continue;
    ordersBySku.set(order.sku, [...(ordersBySku.get(order.sku) ?? []), order]);
  }
  for (const orders of ordersBySku.values()) {
    orders.sort((left, right) => (milliseconds(left.orderTime) ?? 0) - (milliseconds(right.orderTime) ?? 0));
  }

  const exclusions: ForecastEvaluationReport["coverage"]["exclusions"] = structuredClone(evidence.sourceExclusions ?? {});
  let excludedQuantity = Object.values(exclusions).reduce((sum, value) => sum + value.quantity, 0);
  const exclude = (reason: ForecastExclusionReason, quantity: number) => {
    const previous = exclusions[reason] ?? { spells: 0, quantity: 0 };
    exclusions[reason] = { spells: previous.spells + 1, quantity: previous.quantity + quantity };
    excludedQuantity += quantity;
  };
  const preliminary: EvaluatedForecastSpell[] = [];
  const spells = [...evidence.spells].sort(
    (left, right) => (milliseconds(left.publishedAt) ?? Infinity) - (milliseconds(right.publishedAt) ?? Infinity) || left.sku - right.sku || left.publicationItemId.localeCompare(right.publicationItemId),
  );
  for (const spell of spells) {
    const publishedAt = milliseconds(spell.publishedAt);
    if (publishedAt === null) { exclude("missing_publication_date", spell.quantity); continue; }
    const read = readForecasts(spell);
    if (read.reason) { exclude(read.reason, spell.quantity); continue; }
    if (!completeHistory) {
      exclude(
        evidence.orderHistory.gaps.includes("source_limit")
          ? "source_limit"
          : evidence.orderHistory.gaps.length > 0
            ? "order_history_gap"
            : "order_history_incomplete",
        spell.quantity,
      );
      continue;
    }
    const horizonEndsAt = publishedAt + policy.horizonDays * DAY_MS;
    if ((orderFrom !== null && publishedAt < orderFrom) || publishedAt < lookbackFrom || horizonEndsAt > orderCutoff!) {
      exclude(horizonEndsAt > orderCutoff! ? "immature_window" : "outside_order_history", spell.quantity);
      continue;
    }
    const fifo = fifoBySku.get(spell.sku);
    if (!fifo || fifo.state === "unavailable") { exclude("fifo_unavailable", spell.quantity); continue; }
    if (fifo.state === "pending") { exclude("fifo_pending", spell.quantity); continue; }
    if (fifo.state === "held") { exclude("fifo_held", spell.quantity); continue; }
    const nextPublishedAt = milliseconds(spell.nextPublishedAt);
    const exposureObservations = exposureBySku.get(spell.sku) ?? [];
    const firstRemovalAt = exposureObservations
      .filter((observation) => observation.quantity <= 0)
      .map((observation) => milliseconds(observation.observedAt) ?? Infinity)
      .filter((at) => at >= publishedAt)
      .sort((left, right) => left - right)[0];
    const spellEndsAt = Math.min(
      horizonEndsAt,
      nextPublishedAt ?? Infinity,
      firstRemovalAt ?? Infinity,
    );
    const sale = (ordersBySku.get(spell.sku) ?? []).find((order) => {
      const orderTime = milliseconds(order.orderTime) ?? Infinity;
      return order.lifecycle !== "canceled" && order.lifecycle !== "unknown" && orderTime >= publishedAt && orderTime < spellEndsAt;
    });
    if (sale) {
      const split: ForecastSplit = publishedAt < fitCutoff ? "training" : publishedAt < validationCutoff ? "validation" : "reserved";
      preliminary.push({
        publicationItemId: spell.publicationItemId, sku: spell.sku, productLine: spell.productLine,
        quantity: spell.quantity, publishedAt: new Date(publishedAt).toISOString(),
        horizonEndsAt: new Date(horizonEndsAt).toISOString(), split, sold: true,
        soldAt: new Date(milliseconds(sale.orderTime)!).toISOString(),
        orderEvidence: { orderId: sale.orderId, orderNumber: sale.orderNumber, revision: sale.revision, observedAt: sale.observedAt, quantity: sale.quantity },
        fifoRevisionIds: fifo.revisionIds, fifoLatestRecordedAt: fifo.latestRecordedAt,
        exposureObservationIds: exposureObservations
          .filter((observation) => (milliseconds(observation.observedAt) ?? Infinity) <= (milliseconds(sale.orderTime) ?? 0))
          .map((observation) => observation.observationId),
        forecasts: read.forecasts,
        forecastHash: hash({ publicationItemId: spell.publicationItemId, publishedAt: spell.publishedAt, desiredPrice: spell.desiredPrice, evidence: spell.forecastEvidence }),
      });
      continue;
    }
    if (
      firstRemovalAt !== undefined &&
      firstRemovalAt < horizonEndsAt &&
      (nextPublishedAt === null || firstRemovalAt < nextPublishedAt)
    ) {
      exclude("stock_removed", spell.quantity);
      continue;
    }
    if (nextPublishedAt !== null && nextPublishedAt < horizonEndsAt) { exclude("repriced_before_horizon", spell.quantity); continue; }
    if (horizonEndsAt > evaluatedAt || horizonEndsAt > orderCutoff!) { exclude("immature_window", spell.quantity); continue; }
    const observations = exposureObservations.filter((observation) => {
      const at = milliseconds(observation.observedAt) ?? Infinity;
      return at >= publishedAt && at <= horizonEndsAt + policy.maximumExposureGapDays * DAY_MS;
    });
    if (observations.some((observation) => observation.quantity <= 0)) { exclude("stock_removed", spell.quantity); continue; }
    const exposureTimes = [publishedAt, ...observations.map((observation) => milliseconds(observation.observedAt)!).filter((at) => at <= horizonEndsAt), horizonEndsAt];
    const observedThroughHorizon = observations.some((observation) => (milliseconds(observation.observedAt) ?? 0) >= horizonEndsAt && observation.quantity > 0);
    const largestGap = exposureTimes.slice(1).reduce((largest, at, index) => Math.max(largest, at - exposureTimes[index]), 0);
    if (!observedThroughHorizon || largestGap > policy.maximumExposureGapDays * DAY_MS) { exclude("exposure_unavailable", spell.quantity); continue; }
    const split: ForecastSplit = publishedAt < fitCutoff ? "training" : publishedAt < validationCutoff ? "validation" : "reserved";
    preliminary.push({
      publicationItemId: spell.publicationItemId, sku: spell.sku, productLine: spell.productLine,
      quantity: spell.quantity, publishedAt: new Date(publishedAt).toISOString(),
      horizonEndsAt: new Date(horizonEndsAt).toISOString(), split, sold: false, soldAt: null,
      orderEvidence: null, fifoRevisionIds: fifo.revisionIds,
      fifoLatestRecordedAt: fifo.latestRecordedAt,
      exposureObservationIds: observations.map((observation) => observation.observationId),
      forecasts: read.forecasts,
      forecastHash: hash({ publicationItemId: spell.publicationItemId, publishedAt: spell.publishedAt, desiredPrice: spell.desiredPrice, evidence: spell.forecastEvidence }),
    });
  }

  // Keep seller/SKU clusters in one split. The earliest supported spell owns
  // the cluster; later spells in another time block are excluded.
  const splitBySku = new Map<number, ForecastSplit>();
  const observations = preliminary.filter((observation) => {
    const assigned = splitBySku.get(observation.sku);
    if (!assigned) { splitBySku.set(observation.sku, observation.split); return true; }
    if (assigned === observation.split) return true;
    exclude("correlated_sku_cross_split", observation.quantity);
    return false;
  });
  const training = observations.filter((value) => value.split === "training" && milliseconds(value.soldAt ?? value.horizonEndsAt)! <= fitCutoff);
  const validation = observations.filter((value) => value.split === "validation" && milliseconds(value.soldAt ?? value.horizonEndsAt)! <= validationCutoff);
  const reserved = observations.filter((value) => value.split === "reserved");

  const versions = new Map<string, { family: ForecastFamily; version: string }>();
  for (const observation of observations) for (const forecast of observation.forecasts) {
    versions.set(`${forecast.family}|${forecast.version}`, { family: forecast.family, version: forecast.version });
  }
  const models = [...versions.values()].sort((left, right) => left.family.localeCompare(right.family) || left.version.localeCompare(right.version)).map(({ family, version }) => ({
    family, version, training: score(training, family, version), validation: score(validation, family, version),
    reservedCount: reserved.filter((value) => value.forecasts.some((forecast) => forecast.family === family && forecast.version === version)).length,
  }));
  const pairedComparisons: PairedForecastComparison[] = [];
  for (let leftIndex = 0; leftIndex < models.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < models.length; rightIndex += 1) {
      const left = models[leftIndex]; const right = models[rightIndex];
      if (left.family === right.family) continue;
      const paired = validation.filter((observation) =>
        observation.forecasts.some((forecast) => forecast.family === left.family && forecast.version === left.version) &&
        observation.forecasts.some((forecast) => forecast.family === right.family && forecast.version === right.version));
      pairedComparisons.push({
        left: left.version, right: right.version, validationCount: paired.length,
        leftBrier: paired.length ? score(paired, left.family, left.version).brier : null,
        rightBrier: paired.length ? score(paired, right.family, right.version).brier : null,
      });
    }
  }

  // Corrected snapshots remain reportable under their exact version but are
  // never recursively used to fit another raw-model correction.
  const curveModels = models.filter(
    (model) => model.family === "curve" && model.version === `curve:${PRICING_MODEL_VERSION}`,
  ).sort((left, right) => right.training.count - left.training.count || left.version.localeCompare(right.version));
  const curve = curveModels[0];
  let correction: ForecastCorrectionEvaluation | null = null;
  if (curve && curve.training.count > 0) {
    const candidates = policy.candidateMedianDaysMultipliers.map((multiplier) => ({ multiplier, training: score(training, "curve", curve.version, multiplier) }))
      .sort((left, right) => left.training.brier - right.training.brier || left.multiplier - right.multiplier);
    const selected = candidates[0];
    const candidateValidation = score(validation, "curve", curve.version, selected.multiplier);
    const reasons: string[] = [];
    const totalSpellCount = spells.length + Object.values(evidence.sourceExclusions ?? {}).reduce((sum, value) => sum + value.spells, 0);
    const coverage = totalSpellCount === 0 ? 0 : observations.length / totalSpellCount;
    const validationSource = spells.filter((spell) => {
      const publishedAt = milliseconds(spell.publishedAt);
      return publishedAt !== null && publishedAt >= fitCutoff && publishedAt < validationCutoff &&
        readForecasts(spell).forecasts.some((forecast) => forecast.family === "curve" && forecast.version === curve.version);
    });
    const validationCoverage = validationSource.length === 0
      ? 0
      : curve.validation.count / validationSource.length;
    if (curve.training.count < policy.minimumTrainingCount) reasons.push("training_sample_below_minimum");
    if (curve.validation.count < policy.minimumValidationCount) reasons.push("validation_sample_below_minimum");
    if (coverage < policy.minimumCoverage) reasons.push("coverage_below_minimum");
    if (validationCoverage < policy.minimumCoverage) reasons.push("validation_coverage_below_minimum");
    if (evaluatedAt - orderCutoff! > policy.maximumEvidenceAgeDays * DAY_MS) reasons.push("evidence_is_stale");
    const improvement = curve.validation.brier - candidateValidation.brier;
    const calibrationRegression = candidateValidation.calibrationError - curve.validation.calibrationError;
    if (improvement < policy.minimumBrierImprovement) reasons.push("held_out_brier_improvement_below_minimum");
    if (calibrationRegression > policy.maximumCalibrationRegression) reasons.push("held_out_calibration_regressed");
    const productLines = [...new Map(spells.map((spell) => [
      `${spell.productLineId ?? "unknown"}|${spell.productLine}`,
      { productLine: spell.productLine, productLineId: spell.productLineId ?? null },
    ])).values()].sort((left, right) => left.productLine.localeCompare(right.productLine)).map((line) => {
      const lineTraining = training.filter((observation) => observation.productLine === line.productLine);
      const lineValidation = validation.filter((observation) => observation.productLine === line.productLine);
      const lineSource = validationSource.filter((spell) => spell.productLine === line.productLine);
      const lineBaseline = score(lineTraining, "curve", curve.version);
      const lineBaselineValidation = score(lineValidation, "curve", curve.version);
      const lineCandidates = policy.candidateMedianDaysMultipliers.map((multiplier) => ({
        multiplier,
        training: score(lineTraining, "curve", curve.version, multiplier),
      })).sort((left, right) => left.training.brier - right.training.brier || left.multiplier - right.multiplier);
      const lineSelected = lineCandidates[0];
      const lineCandidateValidation = lineSelected
        ? score(lineValidation, "curve", curve.version, lineSelected.multiplier)
        : lineBaselineValidation;
      const lineCoverage = lineSource.length === 0 ? 0 : lineBaselineValidation.count / lineSource.length;
      const lineReasons: string[] = [];
      if (line.productLineId === null) lineReasons.push("product_line_id_unavailable");
      if (lineBaseline.count < policy.minimumTrainingCount) lineReasons.push("training_sample_below_minimum");
      if (lineBaselineValidation.count < policy.minimumValidationCount) lineReasons.push("validation_sample_below_minimum");
      if (lineCoverage < policy.minimumCoverage) lineReasons.push("validation_coverage_below_minimum");
      if (lineBaselineValidation.brier - lineCandidateValidation.brier < policy.minimumBrierImprovement) lineReasons.push("held_out_brier_improvement_below_minimum");
      if (lineCandidateValidation.calibrationError - lineBaselineValidation.calibrationError > policy.maximumCalibrationRegression) lineReasons.push("held_out_calibration_regressed");
      return {
        ...line,
        medianDaysMultiplier: lineSelected?.multiplier ?? null,
        training: lineSelected?.training ?? lineBaseline,
        validation: lineCandidateValidation,
        validationCoverage: lineCoverage,
        eligible: lineReasons.length === 0,
        reasons: lineReasons,
      };
    });
    correction = {
      version: `median-days-scale-v1:${selected.multiplier.toFixed(2)}`,
      family: "curve", sourceModelVersion: curve.version, medianDaysMultiplier: selected.multiplier,
      training: selected.training, validation: candidateValidation,
      validationBrierImprovement: improvement, validationCalibrationRegression: calibrationRegression,
      eligible: reasons.length === 0, reasons, validationCoverage, productLines,
    };
  }
  const includedQuantity = observations.reduce((sum, value) => sum + value.quantity, 0);
  const sourceExcludedSpells = Object.values(evidence.sourceExclusions ?? {}).reduce((sum, value) => sum + value.spells, 0);
  const totalSpellCount = spells.length + sourceExcludedSpells;
  const statusReasons = correction?.reasons ?? (
    exclusions.source_limit
      ? ["source_limit"]
      : exclusions.immature_window && observations.length === 0
        ? ["all_supported_forecasts_immature"]
        : ["no_mature_supported_curve_outcomes"]
  );
  return {
    policy, sellerKey: evidence.sellerKey, evaluatedAt: new Date(evaluatedAt).toISOString(),
    fitCutoff: new Date(fitCutoff).toISOString(), validationCutoff: new Date(validationCutoff).toISOString(),
    evidenceFingerprint: hash({
      policy,
      evidence: { ...evidence, evaluatedAt: new Date(evaluatedAt).toISOString() },
    }),
    status: correction?.eligible ? "eligible" : "abstained", statusReasons,
    provenance: evidence.orderHistory,
    coverage: {
      totalSpells: totalSpellCount, includedSpells: observations.length, includedQuantity,
      coverage: totalSpellCount === 0 ? 0 : observations.length / totalSpellCount,
      excludedSpells: Object.values(exclusions).reduce((sum, value) => sum + value.spells, 0),
      excludedQuantity, exclusions,
    },
    observations, models, pairedComparisons, correction,
  };
}
