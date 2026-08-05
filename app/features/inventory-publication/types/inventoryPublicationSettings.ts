import {
  DEFAULT_CONTINUOUS_PRICING_SETTINGS,
  type ContinuousPricingSettings,
} from "~/features/continuous-pricing/types/continuousPricing";
import {
  DEFAULT_INVENTORY_PUBLICATION_POLICY,
  type InventoryPublicationPolicy,
  type InventoryPublicationSourceType,
} from "./inventoryPublication";

export type SellerPortalAuthenticationStatus =
  | "unknown"
  | "healthy"
  | "invalid";

export interface InventoryPublicationSettings {
  globalPaused: boolean;
  consecutiveFailureLimit: number;
  policy: InventoryPublicationPolicy;
  continuousPricing: ContinuousPricingSettings;
}

export interface InventoryPublicationRuntime {
  authenticationStatus: SellerPortalAuthenticationStatus;
  circuitOpen: boolean;
  consecutiveFailures: number;
  pauseReason: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  runtimeUpdatedAt: Date;
}

export interface InventoryPublicationConfiguration {
  settings: InventoryPublicationSettings;
  runtime: InventoryPublicationRuntime;
  updatedAt: Date;
}

export const DEFAULT_INVENTORY_PUBLICATION_SETTINGS: InventoryPublicationSettings =
  {
    globalPaused: false,
    consecutiveFailureLimit: 3,
    policy: DEFAULT_INVENTORY_PUBLICATION_POLICY,
    continuousPricing: DEFAULT_CONTINUOUS_PRICING_SETTINGS,
  };

export function isAutomaticPublicationAvailable(
  configuration: InventoryPublicationConfiguration,
  sourceType: InventoryPublicationSourceType,
): boolean {
  const { settings, runtime } = configuration;
  return (
    settings.policy.automaticPublishingEnabled &&
    settings.policy.automaticSources[sourceType] &&
    !settings.globalPaused &&
    !runtime.circuitOpen &&
    runtime.authenticationStatus !== "invalid"
  );
}
