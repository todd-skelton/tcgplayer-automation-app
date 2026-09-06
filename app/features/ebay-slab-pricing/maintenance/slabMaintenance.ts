import { sellerAccount } from "../inventory/slabInventory";
export class SlabMaintenanceError extends Error {}
export type MaintenanceSettings = {
  seller: string;
  enabled: boolean;
  includeSupply: boolean;
  intervalMinutes: number;
  batchSize: number;
  refreshBudget: number;
  revision: number;
};
export const defaultMaintenanceSettings = (
  seller: string,
): MaintenanceSettings => ({
  seller: sellerAccount(seller),
  enabled: false,
  includeSupply: false,
  intervalMinutes: 360,
  batchSize: 10,
  refreshBudget: 20,
  revision: 0,
});
export function maintenanceSettings(
  input: MaintenanceSettings,
): MaintenanceSettings {
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    typeof input.includeSupply !== "boolean" ||
    !Number.isInteger(input.intervalMinutes) ||
    input.intervalMinutes < 15 ||
    input.intervalMinutes > 1440 ||
    !Number.isInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > 25 ||
    !Number.isInteger(input.refreshBudget) ||
    input.refreshBudget < 1 ||
    input.refreshBudget > 50 ||
    !Number.isInteger(input.revision) ||
    input.revision < 0
  )
    throw new SlabMaintenanceError(
      "Choose a 15–1,440 minute interval, 1–25 listings and 1–50 refresh jobs per cycle.",
    );
  return {
    seller: sellerAccount(input.seller),
    enabled: input.enabled,
    includeSupply: input.includeSupply,
    intervalMinutes: input.intervalMinutes,
    batchSize: input.batchSize,
    refreshBudget: input.refreshBudget,
    revision: input.revision,
  };
}
// Current delivery has no adopted publication cohort or connected live publisher. Maintenance never grants publication authority.
export const automaticSlabPublication = () => ({
  enabled: false as const,
  reasons: ["live-publisher-not-connected", "no-adopted-automation-cohorts"],
});
