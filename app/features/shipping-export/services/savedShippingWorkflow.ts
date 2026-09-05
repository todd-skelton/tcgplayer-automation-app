import type {
  ShippingPostagePurchaseEntry,
  ShippingShippedMessageResult,
  ShippingTrackingApplyResult,
  TcgPlayerShippingOrder,
} from "../types/shippingExport";

/**
 * The outbound shipping workflow as kept in the browser between page loads.
 *
 * Only what cannot be rebuilt is saved: the loaded orders and the operator's
 * progress. Shipments are rebuilt from the orders under the current shipping
 * configuration, outbound postage is looked up from the server, and the pull
 * sheet is fetched again, so a restore never trusts stale copies of those.
 * Manual shipment edits are not kept across a refresh.
 */
export interface SavedShippingWorkflow {
  version: typeof SAVED_SHIPPING_WORKFLOW_VERSION;
  savedAt: string;
  currentStep: number;
  sellerKey: string;
  loadedSourceLabel: string;
  loadWarnings: string[];
  sourceOrders: TcgPlayerShippingOrder[];
  returnPurchaseResultsByReference: Record<string, ShippingPostagePurchaseEntry>;
  packedOrderNumbers: string[];
  trackingApplyResults: ShippingTrackingApplyResult[];
  shippedMessageResults: ShippingShippedMessageResult[];
}

export type SavedShippingWorkflowInput = Omit<SavedShippingWorkflow, "version" | "savedAt">;

export type SavedShippingWorkflowStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const SAVED_SHIPPING_WORKFLOW_VERSION = 1;

const STORAGE_KEY = "shipping-workflow";

/** The browser's localStorage, or null on the server or when access is blocked. */
export function getSavedShippingWorkflowStorage(): SavedShippingWorkflowStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSavedShippingWorkflow(
  storage: SavedShippingWorkflowStorage,
): SavedShippingWorkflow | null {
  try {
    return parseSavedShippingWorkflow(storage.getItem(STORAGE_KEY));
  } catch (error) {
    console.warn("Failed to read the saved shipping workflow.", error);
    return null;
  }
}

/**
 * Saves the workflow, or clears it when no orders are loaded so a finished or
 * reset workflow does not come back on the next visit.
 */
export function writeSavedShippingWorkflow(
  storage: SavedShippingWorkflowStorage,
  input: SavedShippingWorkflowInput,
): void {
  if (input.sourceOrders.length === 0) {
    clearSavedShippingWorkflow(storage);
    return;
  }

  const saved: SavedShippingWorkflow = {
    version: SAVED_SHIPPING_WORKFLOW_VERSION,
    savedAt: new Date().toISOString(),
    ...input,
  };

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch (error) {
    console.warn("Failed to save the shipping workflow.", error);
  }
}

export function clearSavedShippingWorkflow(storage: SavedShippingWorkflowStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("Failed to clear the saved shipping workflow.", error);
  }
}

/**
 * Accepts only a workflow written by this version of the app with loaded
 * orders; anything else restores nothing rather than half a workflow.
 */
function parseSavedShippingWorkflow(raw: string | null): SavedShippingWorkflow | null {
  if (!raw) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const saved = value as Partial<SavedShippingWorkflow>;
  const isValid =
    saved.version === SAVED_SHIPPING_WORKFLOW_VERSION &&
    typeof saved.savedAt === "string" &&
    !Number.isNaN(Date.parse(saved.savedAt)) &&
    Number.isInteger(saved.currentStep) &&
    typeof saved.sellerKey === "string" &&
    typeof saved.loadedSourceLabel === "string" &&
    Array.isArray(saved.loadWarnings) &&
    saved.loadWarnings.every(isString) &&
    Array.isArray(saved.sourceOrders) &&
    saved.sourceOrders.length > 0 &&
    saved.sourceOrders.every(isShippingOrder) &&
    isRecord(saved.returnPurchaseResultsByReference) &&
    Object.values(saved.returnPurchaseResultsByReference).every(isPurchaseEntry) &&
    Array.isArray(saved.packedOrderNumbers) &&
    saved.packedOrderNumbers.every(isString) &&
    Array.isArray(saved.trackingApplyResults) &&
    saved.trackingApplyResults.every(isOrderResult) &&
    Array.isArray(saved.shippedMessageResults) &&
    saved.shippedMessageResults.every(isOrderResult);

  return isValid ? (saved as SavedShippingWorkflow) : null;
}

/**
 * Checks only that a result names an order and has a status. Its other fields
 * are displayed or compared with `===`, so a missing one cannot cause a skip.
 */
function isOrderResult(value: unknown): value is { orderNumber: string; status: string } {
  return isRecord(value) && isString(value.orderNumber) && isString(value.status);
}

function isPurchaseEntry(value: unknown): value is ShippingPostagePurchaseEntry {
  return isRecord(value) && isString(value.mode) && isRecord(value.result);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Checks the fields the workflow reads from every order before shipments are built. */
function isShippingOrder(value: unknown): value is TcgPlayerShippingOrder {
  return isRecord(value) && isString(value["Order #"]) && isString(value["Tracking #"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
