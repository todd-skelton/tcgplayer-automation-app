import type { EstimatedCostRateAtIntake, PurchaseCostAtIntake } from "./createPendingInventoryBatch";
import type { InventoryIntakeWorkflow } from "../types/inventoryIntakeRun";
import { isIntakeSnapshot, type IntakeQuantity } from "./intakeSnapshot";

export const PENDING_INTAKE_REQUEST_KEY = "inventory-manager-pending-intake-v1";
export interface PendingIntakeRequest {
  requestId: string;
  workflow: InventoryIntakeWorkflow;
  purchaseCost?: PurchaseCostAtIntake;
  estimatedCostRate?: EstimatedCostRateAtIntake;
  expectedInventory: IntakeQuantity[];
  expectedSellerKey: string;
}

const isEstimatedCostRateAtIntake = (value: unknown): value is EstimatedCostRateAtIntake =>
  Boolean(value) && typeof value === "object" &&
  typeof (value as EstimatedCostRateAtIntake).marketPercent === "string" &&
  typeof (value as EstimatedCostRateAtIntake).perCardDeduction === "string";

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
    typeof request.expectedSellerKey !== "string" ||
    (request.estimatedCostRate !== undefined && !isEstimatedCostRateAtIntake(request.estimatedCostRate))
  ) {
    throw new Error(
      "The saved queue request is invalid. Review recent batches before clearing browser session data.",
    );
  }
  return request;
}
