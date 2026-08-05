import type { InventoryPublicationStatus } from "../types/inventoryPublication";

const ALLOWED_TRANSITIONS: Record<
  InventoryPublicationStatus,
  readonly InventoryPublicationStatus[]
> = {
  planned: ["staging", "publishing", "failed"],
  staging: ["planned", "staged", "ambiguous", "failed", "rolled_back"],
  staged: ["publishing", "ambiguous", "failed", "rolled_back"],
  publishing: ["published", "ambiguous", "failed"],
  ambiguous: ["published", "failed", "rolled_back"],
  failed: ["rolled_back"],
  published: [],
  rolled_back: [],
};

export function canTransitionInventoryPublication(
  currentStatus: InventoryPublicationStatus,
  nextStatus: InventoryPublicationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus);
}

export function requireInventoryPublicationTransition(
  currentStatus: InventoryPublicationStatus,
  nextStatus: InventoryPublicationStatus,
): void {
  if (!canTransitionInventoryPublication(currentStatus, nextStatus)) {
    throw new Error(
      `Inventory publication cannot transition from ${currentStatus} to ${nextStatus}.`,
    );
  }
}
