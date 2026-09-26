import { data } from "react-router";
import { InventoryBatchRequestConflictError } from "~/core/db/repositories/inventoryBatches.server";
import { InventoryEconomicsConflictError } from "~/core/db/repositories/inventoryEconomics.server";
import { ensureInventoryBatchPricingWorker } from "~/features/pending-inventory/services/inventoryBatchPricingWorker.server";
import { ensureInventoryPublicationWorker } from "~/features/inventory-publication/services/inventoryPublicationWorker.server";
import {
  findRecentInventoryIntakeRuns,
  getIntakePublicationTarget,
  InventoryIntakeInputError,
  queueInventoryIntake,
} from "../services/inventoryIntakeRuns.server";
import { isIntakeSnapshot } from "../services/intakeSnapshot";

export async function loader() {
  return data({
    runs: await findRecentInventoryIntakeRuns(),
    target: await getIntakePublicationTarget(),
  });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return data({ error: "Method not allowed" }, { status: 405 });
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
  ) {
    return data(
      { error: "Queue requests require same-site JSON." },
      { status: 403 },
    );
  }
  const raw = await request.text();
  if (raw.length > 256_000)
    return data({ error: "Queue request is too large." }, { status: 413 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (
    !body ||
    typeof body.requestId !== "string" ||
    !body.requestId.trim() ||
    body.requestId.length > 180 ||
    !["price_only", "publish"].includes(body.workflow) ||
    !isIntakeSnapshot(body.expectedInventory) ||
    typeof body.expectedSellerKey !== "string" ||
    body.expectedSellerKey.length > 200 ||
    (body.purchaseCost !== undefined &&
      (!body.purchaseCost ||
        typeof body.purchaseCost !== "object" ||
        Array.isArray(body.purchaseCost)))
  ) {
    return data(
      { error: "A request ID and valid queue options are required." },
      { status: 400 },
    );
  }
  try {
    const purchaseCost =
      body.purchaseCost &&
      Object.fromEntries(
        [
          "purchaseReference",
          "totalAmount",
          "provenance",
          "allocationRule",
          "currency",
          "purchasedAt",
        ]
          .filter((key) => body.purchaseCost[key] !== undefined)
          .map((key) => [key, body.purchaseCost[key]]),
      );
    const batch = await queueInventoryIntake({
      requestId: body.requestId.trim(),
      workflow: body.workflow,
      purchaseCost,
      expectedInventory: body.expectedInventory,
      expectedSellerKey: body.expectedSellerKey,
    });
    ensureInventoryBatchPricingWorker();
    ensureInventoryPublicationWorker();
    return data(batch, { status: 201 });
  } catch (error) {
    const status =
      error instanceof InventoryIntakeInputError
        ? 400
        : error instanceof InventoryBatchRequestConflictError ||
            error instanceof InventoryEconomicsConflictError
          ? 409
          : 500;
    return data(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
