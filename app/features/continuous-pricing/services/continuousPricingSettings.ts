import {
  DEFAULT_CONTINUOUS_PRICING_SETTINGS,
  type ContinuousPricingSettings,
} from "../types/continuousPricing";

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

export function normalizeContinuousPricingSettings(
  value: unknown,
): ContinuousPricingSettings {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : DEFAULT_CONTINUOUS_PRICING_SETTINGS.enabled,
    sellerKey:
      typeof input.sellerKey === "string"
        ? input.sellerKey.trim().slice(0, 200)
        : DEFAULT_CONTINUOUS_PRICING_SETTINGS.sellerKey,
    minimumIntervalMinutes: integer(
      input.minimumIntervalMinutes,
      DEFAULT_CONTINUOUS_PRICING_SETTINGS.minimumIntervalMinutes,
      15,
      30 * 24 * 60,
    ),
    inventoryRefreshMinutes: integer(
      input.inventoryRefreshMinutes,
      DEFAULT_CONTINUOUS_PRICING_SETTINGS.inventoryRefreshMinutes,
      5,
      7 * 24 * 60,
    ),
    schedulerPollSeconds: integer(
      input.schedulerPollSeconds,
      DEFAULT_CONTINUOUS_PRICING_SETTINGS.schedulerPollSeconds,
      5,
      60 * 60,
    ),
    batchSize: integer(
      input.batchSize,
      DEFAULT_CONTINUOUS_PRICING_SETTINGS.batchSize,
      1,
      750,
    ),
  };
}
