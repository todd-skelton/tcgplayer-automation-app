import { normalizeContinuousPricingSettings } from "~/features/continuous-pricing/services/continuousPricingSettings";
import {
  DEFAULT_INVENTORY_PUBLICATION_POLICY,
  type InventoryPublicationPolicy,
  type InventoryPublicationSourceType,
} from "../types/inventoryPublication";
import {
  DEFAULT_INVENTORY_PUBLICATION_SETTINGS,
  type InventoryPublicationSettings,
} from "../types/inventoryPublicationSettings";

const SOURCE_TYPES: InventoryPublicationSourceType[] = [
  "pending_inventory",
  "seller",
  "csv",
  "continuous",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = finiteNumber(value, fallback, minimum, maximum);
  return Number.isInteger(normalized) ? normalized : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePolicy(value: unknown): InventoryPublicationPolicy {
  const input = asRecord(value);
  const sourceInput = asRecord(input.automaticSources);
  const automaticSources = {
    ...DEFAULT_INVENTORY_PUBLICATION_POLICY.automaticSources,
  };

  for (const sourceType of SOURCE_TYPES) {
    automaticSources[sourceType] = boolean(sourceInput[sourceType], false);
  }

  return {
    automaticPublishingEnabled: boolean(
      input.automaticPublishingEnabled,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.automaticPublishingEnabled,
    ),
    automaticSources,
    allowWarnings: boolean(
      input.allowWarnings,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.allowWarnings,
    ),
    maximumCandidateAgeMs: integer(
      input.maximumCandidateAgeMs,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.maximumCandidateAgeMs,
      60_000,
      7 * 24 * 60 * 60 * 1000,
    ),
    minimumAbsolutePriceChange: finiteNumber(
      input.minimumAbsolutePriceChange,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.minimumAbsolutePriceChange,
      0,
      10_000,
    ),
    minimumRelativePriceChangePercent: finiteNumber(
      input.minimumRelativePriceChangePercent,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.minimumRelativePriceChangePercent,
      0,
      100,
    ),
    maximumAutomaticDecreasePercent: finiteNumber(
      input.maximumAutomaticDecreasePercent,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.maximumAutomaticDecreasePercent,
      0,
      100,
    ),
    maximumAutomaticIncreasePercent: finiteNumber(
      input.maximumAutomaticIncreasePercent,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.maximumAutomaticIncreasePercent,
      0,
      10_000,
    ),
    stagedMicroBatchMaximum: integer(
      input.stagedMicroBatchMaximum,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.stagedMicroBatchMaximum,
      1,
      750,
    ),
    stagedFlushWindowMs: integer(
      input.stagedFlushWindowMs,
      DEFAULT_INVENTORY_PUBLICATION_POLICY.stagedFlushWindowMs,
      1_000,
      60 * 60 * 1000,
    ),
  };
}

export function normalizeInventoryPublicationSettings(
  value: unknown,
): InventoryPublicationSettings {
  const input = asRecord(value);

  return {
    globalPaused: boolean(
      input.globalPaused,
      DEFAULT_INVENTORY_PUBLICATION_SETTINGS.globalPaused,
    ),
    consecutiveFailureLimit: integer(
      input.consecutiveFailureLimit,
      DEFAULT_INVENTORY_PUBLICATION_SETTINGS.consecutiveFailureLimit,
      1,
      100,
    ),
    policy: normalizePolicy(input.policy),
    continuousPricing: normalizeContinuousPricingSettings(
      input.continuousPricing,
    ),
  };
}
