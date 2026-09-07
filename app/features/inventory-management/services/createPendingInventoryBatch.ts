import type { InventoryBatch } from "~/features/pending-inventory/types/inventoryBatch";

type BatchResponse = Pick<Response, "ok" | "status" | "json">;
type BatchFetch = (
  input: string,
  init: RequestInit,
) => Promise<BatchResponse>;

export class PendingBatchRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "definitive" | "uncertain",
  ) {
    super(message);
    this.name = "PendingBatchRequestError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createPendingInventoryBatch(
  requestId: string,
  send: BatchFetch = fetch,
): Promise<InventoryBatch> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: BatchResponse;
    try {
      response = await send("/api/inventory-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
    } catch (error) {
      if (attempt === 0) continue;
      throw new PendingBatchRequestError(
        `The batch response could not be confirmed: ${errorMessage(error)}`,
        "uncertain",
      );
    }

    let payload: InventoryBatch | { error?: string };
    try {
      payload = (await response.json()) as InventoryBatch | { error?: string };
    } catch (error) {
      if (attempt === 0) continue;
      throw new PendingBatchRequestError(
        `The batch response could not be read: ${errorMessage(error)}`,
        "uncertain",
      );
    }

    if (!response.ok) {
      throw new PendingBatchRequestError(
        "error" in payload && payload.error
          ? payload.error
          : `Batch creation failed with HTTP ${response.status}`,
        "definitive",
      );
    }

    if (!("batchNumber" in payload) || !Number.isInteger(payload.batchNumber)) {
      if (attempt === 0) continue;
      throw new PendingBatchRequestError(
        "The batch response did not identify the created batch",
        "uncertain",
      );
    }
    return payload;
  }

  throw new PendingBatchRequestError(
    "The batch response could not be confirmed",
    "uncertain",
  );
}
