import type {
  InventoryPublicationCandidate,
  InventoryPublicationEligibilityDecision,
  InventoryPublicationEligibilityReason,
  InventoryPublicationMethod,
  InventoryPublicationPolicy,
} from "../types/inventoryPublication";
import { DEFAULT_INVENTORY_PUBLICATION_POLICY } from "../types/inventoryPublication";

function roundToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function addReason(
  reasons: InventoryPublicationEligibilityReason[],
  reason: InventoryPublicationEligibilityReason,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function getInventoryPublicationMethod(
  requiresAbsoluteQuantity: boolean,
): InventoryPublicationMethod {
  return requiresAbsoluteQuantity ? "direct_absolute" : "staged_delta";
}

export function createPricingCandidateKey(
  candidate: Pick<
    InventoryPublicationCandidate,
    "batchNumber" | "sku" | "pricedAt"
  >,
): string {
  return `pricing-result:${candidate.batchNumber}:${candidate.sku}:${candidate.pricedAt.toISOString()}`;
}

export function createInventoryDeltaKey(
  candidate: Pick<InventoryPublicationCandidate, "batchNumber" | "sku">,
): string {
  return `inventory-batch-item:${candidate.batchNumber}:${candidate.sku}`;
}

export function evaluateInventoryPublicationCandidate(
  candidate: InventoryPublicationCandidate,
  policy: InventoryPublicationPolicy = DEFAULT_INVENTORY_PUBLICATION_POLICY,
  now: Date = new Date(),
  mode: "automatic" | "manual" = "automatic",
): InventoryPublicationEligibilityDecision {
  const reasons: InventoryPublicationEligibilityReason[] = [];

  if (mode === "automatic") {
    if (!policy.automaticPublishingEnabled) {
      addReason(reasons, "automatic_publishing_disabled");
    }
    if (!policy.automaticSources[candidate.sourceType]) {
      addReason(reasons, "source_not_enabled");
    }
  }
  if (candidate.errors && candidate.errors.length > 0) {
    addReason(reasons, "pricing_error");
  }
  if (
    !policy.allowWarnings &&
    candidate.warnings &&
    candidate.warnings.length > 0
  ) {
    addReason(reasons, "pricing_warning");
  }
  if (!Number.isInteger(candidate.quantityDelta)) {
    addReason(reasons, "invalid_quantity_delta");
  }
  if (candidate.quantityDelta !== 0 && candidate.inventoryDeltaConsumed) {
    addReason(reasons, "inventory_delta_already_consumed");
  }

  const pricedAtMs = candidate.pricedAt.getTime();
  const candidateAgeMs = now.getTime() - pricedAtMs;
  if (
    !Number.isFinite(pricedAtMs) ||
    candidateAgeMs < 0 ||
    candidateAgeMs > policy.maximumCandidateAgeMs
  ) {
    addReason(reasons, "candidate_stale");
  }

  let roundedPrice: number | undefined;
  let roundedPreviousPrice: number | undefined;
  let absolutePriceChange: number | undefined;
  let relativePriceChangePercent: number | undefined;

  if (candidate.price === null || candidate.price === undefined) {
    addReason(reasons, "missing_price");
  } else if (!isPositiveFinite(candidate.price)) {
    addReason(reasons, "invalid_price");
  } else {
    roundedPrice = roundToCents(candidate.price);
  }

  if (isPositiveFinite(candidate.previousPrice)) {
    roundedPreviousPrice = roundToCents(candidate.previousPrice);
  } else if (candidate.quantityDelta === 0 && !candidate.isNewInventory) {
    addReason(reasons, "missing_previous_price");
  }

  if (roundedPrice !== undefined && roundedPreviousPrice !== undefined) {
    absolutePriceChange = roundToCents(
      Math.abs(roundedPrice - roundedPreviousPrice),
    );
    relativePriceChangePercent =
      (absolutePriceChange / roundedPreviousPrice) * 100;

    if (absolutePriceChange === 0) {
      addReason(reasons, "unchanged_price");
    } else {
      if (
        absolutePriceChange < policy.minimumAbsolutePriceChange ||
        relativePriceChangePercent < policy.minimumRelativePriceChangePercent
      ) {
        addReason(reasons, "below_minimum_change");
      }
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    roundedPrice,
    roundedPreviousPrice,
    absolutePriceChange,
    relativePriceChangePercent,
  };
}
