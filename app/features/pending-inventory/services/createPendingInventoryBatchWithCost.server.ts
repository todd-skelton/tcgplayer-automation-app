import { inventoryBatchesRepository, inventoryEconomicsRepository } from "~/core/db";
import { withTransaction, type Queryable } from "~/core/db/database.server";
import type { NormalizedPurchaseCostDetails } from "~/features/inventory-economics/domain/purchaseCostDetails";
import type { InventoryBatch } from "../types/inventoryBatch";

interface PendingBatchWithCostDependencies {
  transaction: <T>(work:(executor:Queryable)=>Promise<T>)=>Promise<T>;
  createBatch:(requestId:string,executor?:Queryable)=>Promise<InventoryBatch | null>;
  recordPurchaseCost:typeof inventoryEconomicsRepository.recordPurchaseCost;
}

const defaultDependencies: PendingBatchWithCostDependencies = {
  transaction:withTransaction,
  createBatch:inventoryBatchesRepository.createFromPendingInventory,
  recordPurchaseCost:inventoryEconomicsRepository.recordPurchaseCost,
};

export async function createPendingInventoryBatchWithCost(
  requestId:string,
  purchaseCost:NormalizedPurchaseCostDetails | undefined,
  dependencies:PendingBatchWithCostDependencies=defaultDependencies,
):Promise<InventoryBatch | null> {
  return dependencies.transaction(async (executor)=>{
    const batch = await dependencies.createBatch(requestId,executor);
    if (batch && purchaseCost) {
      await dependencies.recordPurchaseCost({
        ...purchaseCost,
        batchNumbers:[batch.batchNumber],
      },executor);
    }
    return batch;
  });
}
