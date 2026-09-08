import { data } from "react-router";
import { inventoryBatchesRepository } from "~/core/db";
import { InventoryBatchRequestConflictError } from "~/core/db/repositories/inventoryBatches.server";
import { InventoryEconomicsConflictError } from "~/core/db/repositories/inventoryEconomics.server";
import { dollarsToCents } from "~/features/inventory-economics/domain/money";
import { normalizePurchaseCostDetails } from "~/features/inventory-economics/domain/purchaseCostDetails";
import { createPendingInventoryBatchWithCost } from "../services/createPendingInventoryBatchWithCost.server";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";

export function parseIntakePurchaseCost(
  value:Record<string,unknown>,
  requestId:string,
  sellerKey:string,
) {
  if (value.allocationRule !== "quantity") {
    throw new Error("Intake purchase cost supports quantity allocation.");
  }
  return normalizePurchaseCostDetails({
    requestId:`${requestId}:purchase-cost`,
    sellerKey,
    purchaseReference:value.purchaseReference,
    currency:value.currency === undefined ? "USD" : value.currency,
    totalAmountCents:dollarsToCents(value.totalAmount,"Purchase total"),
    provenance:value.provenance,
    source:"intake",
    allocationRule:value.allocationRule,
    purchasedAt:value.purchasedAt,
  });
}

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
      purchaseCost?: Record<string, unknown>;
    } | null;
    const requestId =
      typeof body?.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId || requestId.length > 200) {
      return data({ error: "requestId is required" }, { status: 400 });
    }
    let purchaseCost;
    if (body?.purchaseCost) {
      const value = body.purchaseCost;
      const sellerKey = (await getShippingExportConfig()).defaultSellerKey.trim();
      if (!sellerKey) return data({ error: "Configure a default shipping seller before recording purchase cost." }, { status: 409 });
      try { purchaseCost=parseIntakePurchaseCost(value,requestId,sellerKey); }
      catch (error) {
        return data({ error:error instanceof Error ? error.message : String(error) }, { status:400 });
      }
    }

    const batch = purchaseCost
      ? await createPendingInventoryBatchWithCost(requestId,purchaseCost)
      : await inventoryBatchesRepository.createFromPendingInventory(requestId);
    if (!batch) {
      return data(
        { error: "No pending inventory items available to batch" },
        { status: 400 },
      );
    }
    return data(batch, { status: 201 });
  } catch (error) {
    if (error instanceof InventoryBatchRequestConflictError || error instanceof InventoryEconomicsConflictError) {
      return data({ error: error.message }, { status: 409 });
    }
    return data({ error: String(error) }, { status: 500 });
  }
}
