import { data } from "react-router";
import { inventoryBatchesRepository, inventoryEconomicsRepository } from "~/core/db";
import { InventoryBatchRequestConflictError } from "~/core/db/repositories/inventoryBatches.server";
import { dollarsToCents } from "~/features/inventory-economics/domain/money";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";

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
    let purchaseCost: Parameters<typeof inventoryEconomicsRepository.recordPurchaseCost>[0] | undefined;
    if (body?.purchaseCost) {
      const value = body.purchaseCost;
      const sellerKey = (await getShippingExportConfig()).defaultSellerKey.trim();
      if (!sellerKey) return data({ error: "Configure a default shipping seller before recording purchase cost." }, { status: 409 });
      const reference = typeof value.purchaseReference === "string" ? value.purchaseReference.trim() : "";
      const provenance = value.provenance === "estimated" ? "estimated" : value.provenance === "actual" ? "actual" : null;
      const allocationRule = value.allocationRule === "quantity" ? "quantity" : null;
      if (!reference || !provenance || !allocationRule) return data({ error: "Purchase reference, provenance, and allocation rule are required." }, { status: 400 });
      purchaseCost = { requestId:`${requestId}:purchase-cost`,sellerKey,purchaseReference:reference,
        currency:typeof value.currency === "string" ? value.currency.trim() : "USD",
        totalAmountCents:dollarsToCents(value.totalAmount,"Purchase total"),provenance,allocationRule,
        source:"intake",batchNumbers:[],
        ...(typeof value.purchasedAt === "string" && value.purchasedAt ? { purchasedAt:value.purchasedAt } : {}) };
    }

    const batch =
      await inventoryBatchesRepository.createFromPendingInventory(requestId);
    if (!batch) {
      return data(
        { error: "No pending inventory items available to batch" },
        { status: 400 },
      );
    }
    if (purchaseCost) {
      purchaseCost.batchNumbers = [batch.batchNumber];
      await inventoryEconomicsRepository.recordPurchaseCost(purchaseCost);
    }

    return data(batch, { status: 201 });
  } catch (error) {
    if (error instanceof InventoryBatchRequestConflictError) {
      return data({ error: error.message }, { status: 409 });
    }
    return data({ error: String(error) }, { status: 500 });
  }
}
