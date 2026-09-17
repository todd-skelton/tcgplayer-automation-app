import { inventoryBatchesRepository, inventoryEconomicsRepository } from "~/core/db";
import { withTransaction, type Queryable } from "~/core/db/database.server";
import type { NormalizedPurchaseCostDetails } from "~/features/inventory-economics/domain/purchaseCostDetails";
import { recordEstimatedPurchaseCosts } from "~/features/inventory-economics/services/estimatedPurchaseCosts.server";
import type { InventoryBatch } from "../types/inventoryBatch";

interface PendingBatchWithCostDependencies {
  transaction: <T>(work:(executor:Queryable)=>Promise<T>)=>Promise<T>;
  createBatch:(requestId:string,executor?:Queryable)=>Promise<InventoryBatch | null>;
  recordPurchaseCost:typeof inventoryEconomicsRepository.recordPurchaseCost;
  recordEstimatedPurchaseCosts:typeof recordEstimatedPurchaseCosts;
}

const defaultDependencies: PendingBatchWithCostDependencies = {
  transaction:withTransaction,
  createBatch:inventoryBatchesRepository.createFromPendingInventory,
  recordPurchaseCost:inventoryEconomicsRepository.recordPurchaseCost,
  recordEstimatedPurchaseCosts,
};

/**
 * Creates the batch and records its purchase cost in one transaction: the
 * entered cost when one was supplied, otherwise the estimated cost rule for
 * the configured seller. Without a seller the batch is created without cost.
 */
export async function createPendingInventoryBatchWithCost(
  requestId:string,
  purchaseCost:NormalizedPurchaseCostDetails | undefined,
  estimateForSeller:string | null,
  dependencies:PendingBatchWithCostDependencies=defaultDependencies,
):Promise<InventoryBatch | null> {
  return dependencies.transaction(async (executor)=>{
    const batch = await dependencies.createBatch(requestId,executor);
    if (!batch) return batch;
    if (purchaseCost) {
      await dependencies.recordPurchaseCost({
        ...purchaseCost,
        batchNumbers:[batch.batchNumber],
      },executor);
    } else if (estimateForSeller) {
      await dependencies.recordEstimatedPurchaseCosts(
        estimateForSeller,{ batchNumbers:[batch.batchNumber] },undefined,executor);
    }
    return batch;
  });
}
