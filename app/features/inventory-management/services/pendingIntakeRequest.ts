import type { PurchaseCostAtIntake } from "./createPendingInventoryBatch";
import type { InventoryIntakeWorkflow } from "../types/inventoryIntakeRun";
import { isIntakeSnapshot, type IntakeQuantity } from "./intakeSnapshot";

export const PENDING_INTAKE_REQUEST_KEY = "inventory-manager-pending-intake-v1";
export interface PendingIntakeRequest {
  requestId: string;
  workflow: InventoryIntakeWorkflow;
  purchaseCost?: PurchaseCostAtIntake;
  expectedInventory: IntakeQuantity[];
  expectedSellerKey: string;
}

export function readPendingIntakeRequest(
  storage: Pick<Storage, "getItem">,
): PendingIntakeRequest | null {
  const saved = storage.getItem(PENDING_INTAKE_REQUEST_KEY);
  if (!saved) return null;
  const request = JSON.parse(saved) as PendingIntakeRequest;
  if (
    !request.requestId ||
    !["price_only", "publish"].includes(request.workflow) ||
    !isIntakeSnapshot(request.expectedInventory) ||
    typeof request.expectedSellerKey !== "string"
  ) {
    throw new Error(
      "The saved queue request is invalid. Review recent batches before clearing browser session data.",
    );
  }
  return request;
}
