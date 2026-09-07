import { data } from "react-router";
import { inventoryBatchesRepository } from "~/core/db";
import { InventoryBatchRequestConflictError } from "~/core/db/repositories/inventoryBatches.server";

export async function loader() {
  try {
    const batches = await inventoryBatchesRepository.findRecent({
      sourceTypes: ["pending_inventory", "seller", "csv"],
      limit: 100,
    });
    return data(batches, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json().catch(() => null)) as {
      requestId?: unknown;
    } | null;
    const requestId =
      typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId || requestId.length > 200) {
      return data({ error: "requestId is required" }, { status: 400 });
    }

    const batch =
      await inventoryBatchesRepository.createFromPendingInventory(requestId);
    if (!batch) {
      return data(
        { error: "No pending inventory items available to batch" },
        { status: 400 },
      );
    }

    return data(batch, { status: 201 });
  } catch (error) {
    if (error instanceof InventoryBatchRequestConflictError) {
      return data({ error: error.message }, { status: 409 });
    }
    return data({ error: String(error) }, { status: 500 });
  }
}
