import { data } from "react-router";
import {
  PendingInventoryConflictError,
  pendingInventoryRepository,
} from "~/core/db/repositories/pendingInventory.server";
import type {
  InventoryMarketObservation,
  PendingInventoryMetadata,
  PendingInventoryMutation,
} from "~/features/inventory-history/types/inventoryReceipt";
import { fetchInventoryIntakeMarketObservation } from "~/integrations/tcgplayer/client/get-price-points.server";

type PendingInventoryRequest = {
  operation?: unknown;
  requestId?: unknown;
  sku?: unknown;
  quantity?: unknown;
  expectedQuantity?: unknown;
  productLineId?: unknown;
  setId?: unknown;
  productId?: unknown;
};

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function parseRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const requestId = value.trim();
  return requestId.length > 0 && requestId.length <= 200 ? requestId : null;
}

function parseMetadata(body: PendingInventoryRequest): PendingInventoryMetadata | null {
  if (
    !isPositiveInteger(body.productLineId) ||
    !isPositiveInteger(body.setId) ||
    !isPositiveInteger(body.productId)
  ) return null;
  return {
    productLineId: body.productLineId,
    setId: body.setId,
    productId: body.productId,
  };
}

function unavailableMarket(): InventoryMarketObservation {
  return {
    marketValue: null,
    observedAt: null,
    calculatedAt: null,
    provenance: "tcgplayer_price_points_unavailable",
  };
}

async function observeMarket(sku: number): Promise<InventoryMarketObservation> {
  try {
    const observation = await fetchInventoryIntakeMarketObservation(sku);
    if (!observation) return unavailableMarket();

    const calculatedAt = new Date(observation.calculatedAt);
    return {
      marketValue: observation.marketPrice,
      observedAt: new Date(),
      calculatedAt: Number.isNaN(calculatedAt.getTime()) ? null : calculatedAt,
      provenance: "tcgplayer_price_points",
    };
  } catch {
    return unavailableMarket();
  }
}

export async function loader() {
  try {
    return data(await pendingInventoryRepository.findAll(), { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method !== "POST") {
      return data({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as PendingInventoryRequest;
    const requestId = parseRequestId(body.requestId);
    if (!requestId) {
      return data({ error: "requestId is required" }, { status: 400 });
    }

    if (body.operation === "clear") {
      return data(
        await pendingInventoryRepository.mutate({ type: "clear", requestId }),
        { status: 200 },
      );
    }

    if (!isPositiveInteger(body.sku)) {
      return data({ error: "A positive integer SKU is required" }, { status: 400 });
    }
    const metadata = parseMetadata(body);
    if (!metadata) {
      return data(
        { error: "productLineId, setId, and productId are required" },
        { status: 400 },
      );
    }

    let mutation: PendingInventoryMutation;
    if (body.operation === "add") {
      if (!isPositiveInteger(body.quantity)) {
        return data({ error: "Add quantity must be positive" }, { status: 400 });
      }
      const intakeAt = new Date();
      mutation = {
        type: "add",
        requestId,
        sku: body.sku,
        quantity: body.quantity,
        metadata,
        intakeAt,
        market: await observeMarket(body.sku),
      };
    } else if (body.operation === "remove") {
      if (!isPositiveInteger(body.quantity)) {
        return data({ error: "Remove quantity must be positive" }, { status: 400 });
      }
      mutation = {
        type: "remove",
        requestId,
        sku: body.sku,
        quantity: body.quantity,
        metadata,
      };
    } else if (body.operation === "set") {
      if (
        !isNonNegativeInteger(body.quantity) ||
        !isNonNegativeInteger(body.expectedQuantity)
      ) {
        return data(
          { error: "Set quantity and expectedQuantity must be non-negative integers" },
          { status: 400 },
        );
      }
      const intakeAt = new Date();
      mutation = {
        type: "set",
        requestId,
        sku: body.sku,
        quantity: body.quantity,
        expectedQuantity: body.expectedQuantity,
        metadata,
        intakeAt,
        market:
          body.quantity > body.expectedQuantity
            ? await observeMarket(body.sku)
            : unavailableMarket(),
      };
    } else {
      return data({ error: "Invalid operation" }, { status: 400 });
    }

    return data(await pendingInventoryRepository.mutate(mutation), { status: 200 });
  } catch (error) {
    if (error instanceof PendingInventoryConflictError) {
      return data({ error: error.message }, { status: 409 });
    }
    return data({ error: String(error) }, { status: 500 });
  }
}
